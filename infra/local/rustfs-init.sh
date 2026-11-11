#!/bin/sh
set -eu

sign() {
  curl --fail --silent --show-error \
    --aws-sigv4 'aws:amz:us-east-1:s3' \
    --user "${RUSTFS_ACCESS_KEY}:${RUSTFS_SECRET_KEY}" "$@"
}

bucket_url="http://rustfs:9000/${R2_BUCKET_NAME}"
if ! sign --head "$bucket_url" >/dev/null 2>&1; then
  sign --request PUT "$bucket_url" >/dev/null
fi

# Browser uploads use a short-lived S3 signature issued by the Go backend.
# RustFS must permit the local web origins, the stack's and the social gate's,
# to send their signed PUT requests.
extra_origin=''
if [ -n "${R2_BROWSER_ORIGIN:-}" ]; then
  escaped_origin=$(printf '%s' "$R2_BROWSER_ORIGIN" | sed 's/\&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g')
  extra_origin="<AllowedOrigin>${escaped_origin}</AllowedOrigin>"
fi
printf '%s' "<CORSConfiguration xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\"><CORSRule><AllowedOrigin>http://localhost:3000</AllowedOrigin><AllowedOrigin>http://localhost:3010</AllowedOrigin><AllowedOrigin>http://127.0.0.1:3000</AllowedOrigin><AllowedOrigin>https://*.ngrok-free.app</AllowedOrigin><AllowedOrigin>https://*.ngrok.app</AllowedOrigin>${extra_origin}<AllowedMethod>GET</AllowedMethod><AllowedMethod>PUT</AllowedMethod><AllowedHeader>*</AllowedHeader><ExposeHeader>ETag</ExposeHeader><MaxAgeSeconds>3600</MaxAgeSeconds></CORSRule></CORSConfiguration>" |
  sign --request PUT --header 'Content-Type: application/xml' --data-binary @- "${bucket_url}?cors" >/dev/null
