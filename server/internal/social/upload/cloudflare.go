package upload

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ids"
)

// r2Endpoint is overridden in tests.
var r2Endpoint = func(accountID string) string {
	return "https://" + accountID + ".r2.cloudflarestorage.com"
}

// newR2Client builds the S3 client for R2. Checksums are only computed when
// an operation requires them: R2 rejects the flexible checksum headers the
// SDK would otherwise add (the original app strips them with a middleware).
func newR2Client(accountID, accessKey, secretKey, region string) *s3.Client {
	return s3.New(s3.Options{
		BaseEndpoint:               aws.String(r2Endpoint(accountID)),
		Region:                     region,
		UsePathStyle:               true,
		Credentials:                credentials.NewStaticCredentialsProvider(accessKey, secretKey, ""),
		RequestChecksumCalculation: aws.RequestChecksumCalculationWhenRequired,
		ResponseChecksumValidation: aws.ResponseChecksumValidationWhenRequired,
	})
}

// CloudflareStorage stores files in a Cloudflare R2 bucket.
type CloudflareStorage struct {
	client     *s3.Client
	bucketName string
	uploadURL  string
}

func NewCloudflareStorage(accountID, accessKey, secretKey, region, bucketName, uploadURL string) *CloudflareStorage {
	return &CloudflareStorage{
		client:     newR2Client(accountID, accessKey, secretKey, region),
		bucketName: bucketName,
		uploadURL:  uploadURL,
	}
}

func (s *CloudflareStorage) UploadSimple(ctx context.Context, path string) (string, error) {
	body, err := fetchSimple(ctx, path)
	if err != nil {
		return "", err
	}
	detected := DetectFileType(body)
	if detected == nil || !storageAllowedMime[detected.Mime] {
		return "", errors.New("Unsupported file type.")
	}
	id := ids.Make(10)
	key := id + "." + detected.Ext

	if _, err := s.client.PutObject(ctx, &s3.PutObjectInput{
		Bucket:      aws.String(s.bucketName),
		Key:         aws.String(key),
		Body:        bytes.NewReader(body),
		ContentType: aws.String(detected.Mime),
	}); err != nil {
		return "", err
	}
	return s.uploadURL + "/" + key, nil
}

func (s *CloudflareStorage) UploadFile(ctx context.Context, file File) (*UploadedStream, error) {
	uploaded, err := func() (*UploadedStream, error) {
		detected := DetectFileType(file.Buffer)
		if detected == nil || !storageAllowedMime[detected.Mime] {
			return nil, errors.New("Unsupported file type.")
		}
		key := ids.Make(10) + "." + detected.Ext

		if _, err := s.client.PutObject(ctx, &s3.PutObjectInput{
			Bucket:      aws.String(s.bucketName),
			ACL:         privateMediaACL(),
			Key:         aws.String(key),
			Body:        bytes.NewReader(file.Buffer),
			ContentType: aws.String(detected.Mime),
		}); err != nil {
			return nil, err
		}
		return &UploadedStream{
			Filename:     key,
			Mimetype:     file.Mimetype,
			Originalname: key,
			Path:         s.uploadURL + "/" + key,
		}, nil
	}()
	if err != nil {
		slog.Error("Error uploading file to Cloudflare R2:", "error", err)
	}
	return uploaded, err
}

func (s *CloudflareStorage) UploadStream(ctx context.Context, body io.Reader, mimetype, ext string) (*UploadedStream, error) {
	uploaded, err := func() (*UploadedStream, error) {
		if !storageAllowedMime[mimetype] {
			return nil, errors.New("Unsupported file type.")
		}
		key := ids.Make(10) + "." + ext

		// Multipart upload holds only one part in memory at a time instead
		// of the whole body, and does not need to know the length up front
		if err := streamToR2(ctx, s.client, &s3.CreateMultipartUploadInput{
			Bucket:      aws.String(s.bucketName),
			ACL:         privateMediaACL(),
			Key:         aws.String(key),
			ContentType: aws.String(mimetype),
		}, body); err != nil {
			return nil, err
		}
		return &UploadedStream{Filename: key, Mimetype: mimetype, Originalname: key, Path: s.uploadURL + "/" + key}, nil
	}()
	if err != nil {
		slog.Error("Error streaming file to Cloudflare R2:", "error", err)
	}
	return uploaded, err
}

// partSize is @aws-sdk/lib-storage's default (and S3's minimum) part size.
const partSize = 5 * 1024 * 1024

// streamToR2 is @aws-sdk/lib-storage's Upload: a body that fits in one part
// is a single PutObject, anything larger a multipart upload that is aborted
// on failure.
// ponytail: parts go up one at a time; lib-storage sends 4 concurrently,
// add a worker pool if large uploads are too slow.
func streamToR2(ctx context.Context, client *s3.Client, in *s3.CreateMultipartUploadInput, body io.Reader) error {
	buf := make([]byte, partSize)
	n, err := io.ReadFull(body, buf)
	if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
		_, err = client.PutObject(ctx, &s3.PutObjectInput{
			Bucket: in.Bucket, ACL: in.ACL, Key: in.Key, ContentType: in.ContentType,
			Body: bytes.NewReader(buf[:n]),
		})
		return err
	}
	if err != nil {
		return err
	}

	created, err := client.CreateMultipartUpload(ctx, in)
	if err != nil {
		return err
	}
	abort := func(cause error) error {
		_, _ = client.AbortMultipartUpload(context.WithoutCancel(ctx), &s3.AbortMultipartUploadInput{
			Bucket: in.Bucket, Key: in.Key, UploadId: created.UploadId,
		})
		return cause
	}

	var parts []types.CompletedPart
	for number := int32(1); n > 0; number++ {
		part, err := client.UploadPart(ctx, &s3.UploadPartInput{
			Bucket: in.Bucket, Key: in.Key, UploadId: created.UploadId,
			PartNumber: aws.Int32(number), Body: bytes.NewReader(buf[:n]),
		})
		if err != nil {
			return abort(err)
		}
		parts = append(parts, types.CompletedPart{ETag: part.ETag, PartNumber: aws.Int32(number)})

		n, err = io.ReadFull(body, buf)
		if err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, io.ErrUnexpectedEOF) {
			return abort(err)
		}
	}

	if _, err := client.CompleteMultipartUpload(ctx, &s3.CompleteMultipartUploadInput{
		Bucket: in.Bucket, Key: in.Key, UploadId: created.UploadId,
		MultipartUpload: &types.CompletedMultipartUpload{Parts: parts},
	}); err != nil {
		return abort(err)
	}
	return nil
}

const presignExpiry = 3 * time.Hour

func (s *CloudflareStorage) SignDownloadURL(ctx context.Context, fileName string) (string, error) {
	req, err := s3.NewPresignClient(s.client).PresignGetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(s.bucketName), Key: aws.String(fileName),
	}, s3.WithPresignExpires(presignExpiry))
	if err != nil {
		return "", err
	}
	return req.URL, nil
}

func (s *CloudflareStorage) SignUploadURL(ctx context.Context, fileName, contentType string) (string, error) {
	req, err := s3.NewPresignClient(s.client).PresignPutObject(ctx, &s3.PutObjectInput{
		Bucket: aws.String(s.bucketName), Key: aws.String(fileName), ContentType: aws.String(contentType),
	}, s3.WithPresignExpires(presignExpiry))
	if err != nil {
		return "", err
	}
	return req.URL, nil
}

func (s *CloudflareStorage) PublicURL(fileName string) string {
	return s.uploadURL + "/" + fileName
}

func (s *CloudflareStorage) ReadFile(ctx context.Context, fileName string) (string, error) {
	out, err := s.client.GetObject(ctx, &s3.GetObjectInput{Bucket: aws.String(s.bucketName), Key: aws.String(fileName)})
	if err != nil {
		return "", err
	}
	defer out.Body.Close()
	const maxReadFileBytes = 10 << 20
	data, err := io.ReadAll(io.LimitReader(out.Body, maxReadFileBytes+1))
	if err != nil {
		return "", err
	}
	if len(data) > maxReadFileBytes {
		return "", fmt.Errorf("file %q exceeds %d bytes", fileName, maxReadFileBytes)
	}
	return string(data), nil
}

func (s *CloudflareStorage) WriteFile(ctx context.Context, fileName, body, contentType string) error {
	_, err := s.client.PutObject(ctx, &s3.PutObjectInput{
		Bucket:      aws.String(s.bucketName),
		Key:         aws.String(fileName),
		Body:        strings.NewReader(body),
		ContentType: aws.String(contentType),
	})
	return err
}

// RemoveFile accepts either the public URL or the bare key.
func (s *CloudflareStorage) RemoveFile(ctx context.Context, filePath string) error {
	fileName := filePath[strings.LastIndex(filePath, "/")+1:]
	if fileName == "" {
		return nil
	}
	_, err := s.client.DeleteObject(ctx, &s3.DeleteObjectInput{Bucket: aws.String(s.bucketName), Key: aws.String(fileName)})
	return err
}
