package media

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	v4 "github.com/aws/aws-sdk-go-v2/aws/signer/v4"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
	"github.com/aws/smithy-go"
)

// S3Store keeps media bytes outside PostgreSQL while asset authorization and
// object keys stay in the canonical product database. It works with R2 and
// the S3-compatible object store in local Compose.
type S3Store struct {
	bucket         string
	client         *s3.Client
	signer         *s3.PresignClient
	deliverySigner *s3.PresignClient
}

func NewS3Store(endpoint, browserEndpoint, region, bucket, accessKey, secretKey string) (*S3Store, error) {
	if endpoint == "" || bucket == "" || accessKey == "" || secretKey == "" {
		return nil, errors.New("R2 endpoint, bucket, access key, and secret key are required")
	}
	if region == "" {
		region = "auto"
	}
	if browserEndpoint == "" {
		browserEndpoint = endpoint
	}
	for _, raw := range []string{endpoint, browserEndpoint} {
		u, err := url.Parse(raw)
		if err != nil || u.Host == "" || (u.Scheme != "https" && u.Scheme != "http") || u.RawQuery != "" || u.Fragment != "" {
			return nil, errors.New("R2 endpoint must be an http(s) URL")
		}
	}
	client := func(base string) *s3.Client {
		return s3.New(s3.Options{
			BaseEndpoint: aws.String(strings.TrimRight(base, "/")),
			Region:       region, UsePathStyle: true,
			Credentials:                credentials.NewStaticCredentialsProvider(accessKey, secretKey, ""),
			RequestChecksumCalculation: aws.RequestChecksumCalculationWhenRequired,
			ResponseChecksumValidation: aws.ResponseChecksumValidationWhenRequired,
		})
	}
	internal := client(endpoint)
	return &S3Store{bucket: bucket, client: internal, signer: s3.NewPresignClient(client(browserEndpoint)),
		deliverySigner: s3.NewPresignClient(internal)}, nil
}

func NewS3StoreFromEnvironment() (*S3Store, error) {
	if os.Getenv("R2_ENDPOINT") == "" && os.Getenv("R2_BUCKET_NAME") == "" {
		return nil, nil
	}
	store, err := NewS3Store(os.Getenv("R2_ENDPOINT"), os.Getenv("R2_BROWSER_ENDPOINT"),
		os.Getenv("R2_REGION"), os.Getenv("R2_BUCKET_NAME"),
		os.Getenv("R2_ACCESS_KEY_ID"), os.Getenv("R2_SECRET_ACCESS_KEY"))
	if err != nil || os.Getenv("R2_DELIVERY_ENDPOINT") == "" {
		return store, err
	}
	// Providers need a public signing origin even when storage reads stay internal.
	delivery, err := NewS3Store(os.Getenv("R2_DELIVERY_ENDPOINT"), "",
		os.Getenv("R2_REGION"), os.Getenv("R2_BUCKET_NAME"),
		os.Getenv("R2_ACCESS_KEY_ID"), os.Getenv("R2_SECRET_ACCESS_KEY"))
	if err != nil {
		return nil, err
	}
	store.deliverySigner = delivery.deliverySigner
	return store, nil
}

// SignUpload signs a write-once PUT: the caller must send If-None-Match: *,
// so a replayed URL cannot overwrite bytes that were already uploaded.
func (s *S3Store) SignUpload(ctx context.Context, key, mediaType string) (string, error) {
	request, err := s.signer.PresignPutObject(ctx, &s3.PutObjectInput{
		Bucket: aws.String(s.bucket), Key: aws.String(key), ContentType: aws.String(mediaType),
		IfNoneMatch: aws.String("*"),
	}, s3.WithPresignExpires(2*time.Minute))
	if err != nil {
		return "", fmt.Errorf("sign media upload: %w", err)
	}
	return request.URL, nil
}

// UploadedPart is one stored part of a multipart upload.
type UploadedPart struct {
	Number int
	Bytes  int64
	ETag   string
}

// CreateMultipartUpload starts a multipart upload of a large file, so a
// dropped connection resends one part instead of the whole file.
func (s *S3Store) CreateMultipartUpload(ctx context.Context, key, mediaType string) (string, error) {
	output, err := s.client.CreateMultipartUpload(ctx, &s3.CreateMultipartUploadInput{
		Bucket: aws.String(s.bucket), Key: aws.String(key), ContentType: aws.String(mediaType),
	})
	if err != nil {
		return "", fmt.Errorf("start multipart upload: %w", err)
	}
	return aws.ToString(output.UploadId), nil
}

// SignUploadPart signs a PUT of one part with its exact length. Storage
// replaces a part sent again, which is how a failed part is retried; only
// the server completes the upload.
func (s *S3Store) SignUploadPart(ctx context.Context, key, uploadID string, number int, bytes int64) (string, error) {
	request, err := s.signer.PresignUploadPart(ctx, &s3.UploadPartInput{
		Bucket: aws.String(s.bucket), Key: aws.String(key), UploadId: aws.String(uploadID),
		PartNumber: aws.Int32(int32(number)), ContentLength: aws.Int64(bytes),
	}, s3.WithPresignExpires(15*time.Minute))
	if err != nil {
		return "", fmt.Errorf("sign upload part: %w", err)
	}
	return request.URL, nil
}

// ListUploadedParts lists the parts storage holds, so the server, not the
// browser, knows each part's ETag and size.
func (s *S3Store) ListUploadedParts(ctx context.Context, key, uploadID string) ([]UploadedPart, error) {
	parts := []UploadedPart{}
	paginator := s3.NewListPartsPaginator(s.client, &s3.ListPartsInput{
		Bucket: aws.String(s.bucket), Key: aws.String(key), UploadId: aws.String(uploadID),
	})
	for paginator.HasMorePages() {
		page, err := paginator.NextPage(ctx)
		if err != nil {
			return nil, fmt.Errorf("list upload parts: %w", err)
		}
		for _, part := range page.Parts {
			parts = append(parts, UploadedPart{Number: int(aws.ToInt32(part.PartNumber)),
				Bytes: aws.ToInt64(part.Size), ETag: aws.ToString(part.ETag)})
		}
	}
	return parts, nil
}

// CompleteMultipartUpload joins the parts into the object.
func (s *S3Store) CompleteMultipartUpload(ctx context.Context, key, uploadID string, parts []UploadedPart) error {
	completed := make([]types.CompletedPart, len(parts))
	for i, part := range parts {
		completed[i] = types.CompletedPart{PartNumber: aws.Int32(int32(part.Number)), ETag: aws.String(part.ETag)}
	}
	_, err := s.client.CompleteMultipartUpload(ctx, &s3.CompleteMultipartUploadInput{
		Bucket: aws.String(s.bucket), Key: aws.String(key), UploadId: aws.String(uploadID),
		MultipartUpload: &types.CompletedMultipartUpload{Parts: completed},
	})
	if err != nil {
		return fmt.Errorf("complete multipart upload: %w", err)
	}
	return nil
}

// AbortMultipartUpload discards an unfinished upload's parts; one already
// completed or aborted is not an error.
func (s *S3Store) AbortMultipartUpload(ctx context.Context, key, uploadID string) error {
	_, err := s.client.AbortMultipartUpload(ctx, &s3.AbortMultipartUploadInput{
		Bucket: aws.String(s.bucket), Key: aws.String(key), UploadId: aws.String(uploadID),
	})
	var apiError smithy.APIError
	if errors.As(err, &apiError) && apiError.ErrorCode() == "NoSuchUpload" {
		return nil
	}
	return err
}

// unhoistedSigner signs every header as a header. The default presigner moves
// x-amz-* headers such as the checksum into the query string, where storage
// may not check them.
var unhoistedSigner = v4.NewSigner(func(o *v4.SignerOptions) {
	o.DisableURIPathEscaping = true
	o.DisableHeaderHoisting = true
})

// SignChecksummedUpload signs a write-once PUT of exactly size bytes whose
// SHA-256 is digest. The caller sends the returned headers: storage refuses a
// body of another length or content, and If-None-Match: * refuses to overwrite
// an object already stored.
func (s *S3Store) SignChecksummedUpload(ctx context.Context, key, mediaType string, size int64, digest []byte, expires time.Duration) (string, http.Header, error) {
	request, err := s.signer.PresignPutObject(ctx, &s3.PutObjectInput{
		Bucket: aws.String(s.bucket), Key: aws.String(key), ContentType: aws.String(mediaType),
		ContentLength: aws.Int64(size), ChecksumSHA256: aws.String(base64.StdEncoding.EncodeToString(digest)),
		IfNoneMatch: aws.String("*"),
	}, s3.WithPresignExpires(expires), func(o *s3.PresignOptions) { o.Presigner = unhoistedSigner })
	if err != nil {
		return "", nil, fmt.Errorf("sign checksummed upload: %w", err)
	}
	headers := request.SignedHeader.Clone()
	headers.Del("Host") // the HTTP client sets it from the URL
	return request.URL, headers, nil
}

func (s *S3Store) SignDownload(ctx context.Context, key string) (string, error) {
	return s.SignDownloadFor(ctx, key, 2*time.Minute)
}

// SignDownloadFor signs a GET valid for expires, for media a person plays and
// seeks through long after the first request.
func (s *S3Store) SignDownloadFor(ctx context.Context, key string, expires time.Duration) (string, error) {
	request, err := s.signer.PresignGetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(s.bucket), Key: aws.String(key),
	}, s3.WithPresignExpires(expires))
	if err != nil {
		return "", fmt.Errorf("sign media download: %w", err)
	}
	return request.URL, nil
}

// SignDelivery is called only when a scheduled post is due. Providers can
// fetch this private object for the next 24 hours without a stored public URL.
func (s *S3Store) SignDelivery(ctx context.Context, key string) (string, error) {
	request, err := s.deliverySigner.PresignGetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(s.bucket), Key: aws.String(key),
	}, s3.WithPresignExpires(24*time.Hour))
	if err != nil {
		return "", fmt.Errorf("sign media delivery: %w", err)
	}
	return request.URL, nil
}

func (s *S3Store) Exists(ctx context.Context, key string) (bool, error) {
	_, err := s.client.HeadObject(ctx, &s3.HeadObjectInput{Bucket: aws.String(s.bucket), Key: aws.String(key)})
	if err == nil {
		return true, nil
	}
	var apiError smithy.APIError
	if errors.As(err, &apiError) && (apiError.ErrorCode() == "NotFound" || apiError.ErrorCode() == "NoSuchKey") {
		return false, nil
	}
	return false, fmt.Errorf("check media object: %w", err)
}

func (s *S3Store) Delete(ctx context.Context, key string) error {
	_, err := s.client.DeleteObject(ctx, &s3.DeleteObjectInput{Bucket: aws.String(s.bucket), Key: aws.String(key)})
	return err
}

// Open streams an object, for reading it back without holding it whole.
func (s *S3Store) Open(ctx context.Context, key string) (io.ReadCloser, error) {
	response, err := s.client.GetObject(ctx, &s3.GetObjectInput{Bucket: aws.String(s.bucket), Key: aws.String(key)})
	if err != nil {
		return nil, err
	}
	return response.Body, nil
}

func (s *S3Store) Read(ctx context.Context, key string) ([]byte, error) {
	response, err := s.client.GetObject(ctx, &s3.GetObjectInput{Bucket: aws.String(s.bucket), Key: aws.String(key)})
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	// Asset intake accepts LinkedIn PDFs up to 100 MiB.
	const maxMediaBytes = 100 << 20
	content, err := io.ReadAll(io.LimitReader(response.Body, maxMediaBytes+1))
	if err != nil {
		return nil, err
	}
	if len(content) > maxMediaBytes {
		return nil, fmt.Errorf("media object exceeds %d bytes", maxMediaBytes)
	}
	return content, nil
}

func (s *S3Store) Put(ctx context.Context, key, mediaType string, body io.Reader) error {
	_, err := s.client.PutObject(ctx, &s3.PutObjectInput{
		Bucket: aws.String(s.bucket), Key: aws.String(key), ContentType: aws.String(mediaType), Body: body,
	})
	return err
}

var _ interface {
	SignUpload(context.Context, string, string) (string, error)
	SignDownload(context.Context, string) (string, error)
	Exists(context.Context, string) (bool, error)
} = (*S3Store)(nil)

// TenantObjects is used by the publisher and maintenance worker. It checks
// ownership before touching object storage, including deletion retries.
type TenantObjects struct{ store *S3Store }

func NewTenantObjects(store *S3Store) *TenantObjects { return &TenantObjects{store: store} }

func validTenantObjectKey(organizationID, key string) bool {
	if !safeSegment(organizationID) || !strings.HasPrefix(key, "org/"+organizationID+"/") {
		return false
	}
	for _, part := range strings.Split(key, "/") {
		if !safeSegment(part) {
			return false
		}
	}
	return true
}

func safeSegment(value string) bool {
	if value == "" || value == "." || value == ".." {
		return false
	}
	for _, r := range value {
		if (r < 'a' || r > 'z') && (r < 'A' || r > 'Z') && (r < '0' || r > '9') && r != '.' && r != '_' && r != '-' {
			return false
		}
	}
	return true
}

func (o *TenantObjects) Read(ctx context.Context, organizationID, key string) ([]byte, error) {
	if !validTenantObjectKey(organizationID, key) {
		return nil, errors.New("media object is outside the active organization")
	}
	return o.store.Read(ctx, key)
}

func (o *TenantObjects) Delete(ctx context.Context, organizationID, key string) error {
	if !validTenantObjectKey(organizationID, key) {
		return errors.New("media object is outside the active organization")
	}
	return o.store.Delete(ctx, key)
}

// AbortUpload discards an unfinished multipart upload of a tenant's object.
func (o *TenantObjects) AbortUpload(ctx context.Context, organizationID, key, uploadID string) error {
	if !validTenantObjectKey(organizationID, key) {
		return errors.New("media object is outside the active organization")
	}
	return o.store.AbortMultipartUpload(ctx, key, uploadID)
}

func (o *TenantObjects) SignDelivery(ctx context.Context, organizationID, key string) (string, error) {
	if !validTenantObjectKey(organizationID, key) {
		return "", errors.New("media object is outside the active organization")
	}
	return o.store.SignDelivery(ctx, key)
}
