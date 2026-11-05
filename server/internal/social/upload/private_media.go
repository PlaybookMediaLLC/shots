package upload

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	v4 "github.com/aws/aws-sdk-go-v2/aws/signer/v4"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
)

// PrivateMediaSigner turns a stored, stable R2 object URL into a short-lived
// download URL when a post is actually published. A post scheduled months
// ahead must not store a presigned URL that expires before the worker runs.
type PrivateMediaSigner struct {
	base   *url.URL
	bucket string
	client *s3.PresignClient
}

// NewPrivateMediaSigner reads the dedicated social bucket configuration. Nil
// means the existing public-bucket or local-storage behavior is in use.
func NewPrivateMediaSigner() (*PrivateMediaSigner, error) {
	if os.Getenv("SOCIAL_PRIVATE_MEDIA") != "true" {
		return nil, nil
	}
	if os.Getenv("STORAGE_PROVIDER") != "cloudflare" {
		return nil, errors.New("SOCIAL_PRIVATE_MEDIA requires STORAGE_PROVIDER=cloudflare")
	}
	base, err := url.Parse(strings.TrimRight(os.Getenv("CLOUDFLARE_BUCKET_URL"), "/"))
	if err != nil || base == nil || (base.Scheme != "https" && base.Scheme != "http") || base.Host == "" || base.RawQuery != "" || base.Fragment != "" {
		return nil, errors.New("SOCIAL_PRIVATE_MEDIA requires a valid CLOUDFLARE_BUCKET_URL")
	}
	for _, name := range []string{"CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_ACCESS_KEY", "CLOUDFLARE_SECRET_ACCESS_KEY", "CLOUDFLARE_BUCKETNAME"} {
		if os.Getenv(name) == "" {
			return nil, fmt.Errorf("SOCIAL_PRIVATE_MEDIA requires %s", name)
		}
	}
	region := os.Getenv("CLOUDFLARE_REGION")
	if region == "" {
		region = "auto"
	}
	return &PrivateMediaSigner{
		base:   base,
		bucket: os.Getenv("CLOUDFLARE_BUCKETNAME"),
		client: s3.NewPresignClient(newR2Client(os.Getenv("CLOUDFLARE_ACCOUNT_ID"), os.Getenv("CLOUDFLARE_ACCESS_KEY"), os.Getenv("CLOUDFLARE_SECRET_ACCESS_KEY"), region),
			func(o *s3.PresignOptions) {
				// The S3 client's own signer settings, as newDefaultV4Signer sets them.
				o.Presigner = hourSigner{v4.NewSigner(func(so *v4.SignerOptions) { so.DisableURIPathEscaping = true })}
			}),
	}, nil
}

// hourSigner signs as of the start of the hour. A file then keeps one link
// for the whole hour, so a browser can cache it instead of loading it again on
// each page. The link stays valid for at least 23 hours.
type hourSigner struct{ *v4.Signer }

func (s hourSigner) PresignHTTP(ctx context.Context, credentials aws.Credentials, r *http.Request, payloadHash, service, region string, signingTime time.Time, optFns ...func(*v4.SignerOptions)) (string, http.Header, error) {
	return s.Signer.PresignHTTP(ctx, credentials, r, payloadHash, service, region, signingTime.UTC().Truncate(time.Hour), optFns...)
}

const privateMediaExpiry = 24 * time.Hour

// SignURL leaves external media alone. It also refreshes an older presigned
// URL for our bucket; only the object key, never its old query, is retained.
func (s *PrivateMediaSigner) SignURL(ctx context.Context, raw string) (string, error) {
	if s == nil || raw == "" {
		return raw, nil
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != s.base.Scheme || !strings.EqualFold(u.Host, s.base.Host) {
		return raw, nil
	}
	basePath := strings.TrimRight(s.base.Path, "/") + "/"
	if !strings.HasPrefix(u.Path, basePath) {
		return raw, nil
	}
	key := strings.TrimPrefix(u.Path, basePath)
	if key == "" || strings.HasPrefix(key, "/") || strings.Contains(key, "..") || strings.ContainsAny(key, "\\\x00") {
		return "", errors.New("invalid private media key")
	}
	request, err := s.client.PresignGetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(s.bucket), Key: aws.String(key),
	}, s3.WithPresignExpires(privateMediaExpiry))
	if err != nil {
		return "", fmt.Errorf("sign private media: %w", err)
	}
	return request.URL, nil
}

// SignManagedURL fails closed for a direct tenant publish. The media returned
// by our staging API must belong to the configured private bucket.
func (s *PrivateMediaSigner) SignManagedURL(ctx context.Context, raw string) (string, error) {
	if s == nil {
		return "", errors.New("private media signer is unavailable")
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != s.base.Scheme || !strings.EqualFold(u.Host, s.base.Host) ||
		!strings.HasPrefix(u.Path, strings.TrimRight(s.base.Path, "/")+"/") {
		return "", errors.New("media is outside the private bucket")
	}
	return s.SignURL(ctx, raw)
}

func privateMediaACL() types.ObjectCannedACL {
	if os.Getenv("SOCIAL_PRIVATE_MEDIA") == "true" {
		return ""
	}
	return types.ObjectCannedACLPublicRead
}
