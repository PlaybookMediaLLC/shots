# syntax=docker/dockerfile:1.7
# One image for every environment. Production runs the default entry point,
# cmd/combined, which starts the product API and worker. Compose and kind select one
# binary for each service with the entry point.
FROM golang:1.26-alpine AS build

WORKDIR /src
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY . .
ARG GO_BUILD_TAGS=""
# Share Go module and build caches across binaries without exporting them into image layers.
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/social-migrate ./cmd/social-migrate && \
    CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/social-credentials ./cmd/social-credentials && \
    CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/platform-migrate ./cmd/platform-migrate && \
    CGO_ENABLED=0 go build -tags "$GO_BUILD_TAGS" -trimpath -ldflags="-s -w" -o /out/publishing-orchestrator ./cmd/product-worker && \
    CGO_ENABLED=0 go build -tags "$GO_BUILD_TAGS" -trimpath -ldflags="-s -w" -o /out/publishing-backend ./cmd/product-api && \
    CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/combined-backend ./cmd/combined

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/social-migrate /social-migrate
COPY --from=build /out/social-credentials /social-credentials
COPY --from=build /out/platform-migrate /platform-migrate
COPY --from=build /out/publishing-orchestrator /publishing-orchestrator
COPY --from=build /out/publishing-backend /publishing-backend
COPY --from=build /out/combined-backend /combined-backend
# The commit the image is built from; telemetry reports it as service.version.
# Keep after COPY layers so per-commit SHA updates never invalidate binary layers.
ARG SERVICE_VERSION=dev
ENV TZ=UTC SERVICE_VERSION=$SERVICE_VERSION
EXPOSE 3000
EXPOSE 3003
ENTRYPOINT ["/combined-backend"]
