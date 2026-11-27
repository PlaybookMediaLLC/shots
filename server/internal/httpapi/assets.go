package httpapi

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/product"
	"github.com/google/uuid"
)

func (s *Server) listAssets(w http.ResponseWriter, r *http.Request) {
	limit := 50
	if r.URL.Query().Has("limit") {
		value, err := strconv.Atoi(r.URL.Query().Get("limit"))
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid asset page size")
			return
		}
		limit = value
	}
	cursor := strings.TrimSpace(r.URL.Query().Get("cursor"))
	if limit < 1 || limit > 100 || len(cursor) > 512 {
		writeError(w, http.StatusBadRequest, "invalid asset query")
		return
	}
	page, err := s.configuration.ListAssets(r.Context(), workspaceActor(r), product.AssetListOptions{Search: r.URL.Query().Get("search"), Classification: r.URL.Query().Get("classification"), Limit: limit, Cursor: cursor, Type: r.URL.Query().Get("type"), Sort: r.URL.Query().Get("sort")})
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, page)
}

func (s *Server) deleteAsset(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if _, err := uuid.Parse(id); err != nil {
		writeError(w, http.StatusBadRequest, "invalid asset ID")
		return
	}
	result, err := s.configuration.DeleteAsset(r.Context(), workspaceActor(r), id)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	switch result {
	case product.AssetMissing:
		writeError(w, http.StatusNotFound, "Asset not found.")
	case product.AssetInUse:
		writeError(w, http.StatusConflict, "Asset is in use by a creative variant.")
	case product.AssetNotReady:
		writeError(w, http.StatusConflict, "Only uploaded assets can be deleted.")
	default:
		writeJSON(w, http.StatusOK, map[string]string{"status": string(result)})
	}
}

func (s *Server) signAssetUpload(w http.ResponseWriter, r *http.Request) {
	var input product.AssetUploadInput
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	result, err := s.configuration.SignAssetUpload(r.Context(), workspaceActor(r), input)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, result)
}

func (s *Server) completeAssetUpload(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if _, err := uuid.Parse(id); err != nil {
		writeError(w, http.StatusBadRequest, "invalid asset ID")
		return
	}
	var input struct {
		SHA256 *string `json:"sha256"`
		// PartSHA256 is each part's digest, for a file sent in parts.
		PartSHA256 []string `json:"partSha256"`
	}
	if err := decodeJSON(r, &input); err != nil || len(input.PartSHA256) > 10_000 {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	row, err := s.configuration.CompleteAssetUpload(r.Context(), workspaceActor(r), id, input.SHA256, input.PartSHA256...)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"asset": row})
}

func (s *Server) signAssetUploadParts(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if _, err := uuid.Parse(id); err != nil {
		writeError(w, http.StatusBadRequest, "invalid asset ID")
		return
	}
	var input struct {
		Parts []int `json:"parts"`
	}
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	result, err := s.configuration.SignAssetUploadParts(r.Context(), workspaceActor(r), id, input.Parts)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) signAssetDownload(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if _, err := uuid.Parse(id); err != nil {
		writeError(w, http.StatusBadRequest, "invalid asset ID")
		return
	}
	url, err := s.configuration.SignAssetDownload(r.Context(), workspaceActor(r), id)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"downloadUrl": url})
}

func (s *Server) signAssetDownloads(w http.ResponseWriter, r *http.Request) {
	var input struct {
		AssetIDs []string `json:"assetIds"`
	}
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if len(input.AssetIDs) > 100 {
		writeError(w, http.StatusBadRequest, "too many asset IDs")
		return
	}
	for _, id := range input.AssetIDs {
		if _, err := uuid.Parse(id); err != nil {
			writeError(w, http.StatusBadRequest, "invalid asset ID")
			return
		}
	}
	urls, err := s.configuration.SignAssetDownloads(r.Context(), workspaceActor(r), input.AssetIDs)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"urls": urls})
}

type assetStreamStore interface {
	OpenAssetStream(ctx context.Context, actor product.Actor, assetID, rangeHeader, ifNoneMatch string) (*product.AssetStream, error)
	OpenAssetDownloadStream(ctx context.Context, assetID, token, requestID, rangeHeader, ifNoneMatch string) (*product.AssetStream, error)
}

const privateRevalidateCacheControl = "private, max-age=0, must-revalidate"

func (s *Server) readAsset(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if _, err := uuid.Parse(id); err != nil {
		writeError(w, http.StatusBadRequest, "invalid asset ID")
		return
	}
	if streamer, ok := s.configuration.(assetStreamStore); ok {
		stream, err := streamer.OpenAssetStream(r.Context(), workspaceActor(r), id, r.Header.Get("Range"), r.Header.Get("If-None-Match"))
		if err != nil {
			writeStoreError(w, err)
			return
		}
		serveAssetStream(w, r, stream)
		return
	}
	body, mediaType, err := s.configuration.ReadAsset(r.Context(), workspaceActor(r), id)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	serveAssetBytes(w, r, body, mediaType)
}

func (s *Server) readAssetDownload(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if _, err := uuid.Parse(id); err != nil {
		writeError(w, http.StatusBadRequest, "invalid asset ID")
		return
	}
	var input struct {
		Token string `json:"token"`
	}
	if err := decodeJSON(r, &input); err != nil || len(input.Token) > 4096 {
		writeError(w, http.StatusBadRequest, "invalid download grant")
		return
	}
	if streamer, ok := s.configuration.(assetStreamStore); ok {
		stream, err := streamer.OpenAssetDownloadStream(r.Context(), id, input.Token, r.Header.Get("X-Request-ID"), r.Header.Get("Range"), r.Header.Get("If-None-Match"))
		if err != nil {
			writeStoreError(w, err)
			return
		}
		serveAssetStream(w, r, stream)
		return
	}
	body, mediaType, err := s.configuration.ReadAssetDownload(r.Context(), id, input.Token, r.Header.Get("X-Request-ID"))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	serveAssetBytes(w, r, body, mediaType)
}

func serveAssetStream(w http.ResponseWriter, r *http.Request, stream *product.AssetStream) {
	if stream.Body != nil {
		defer stream.Body.Close()
	}
	if stream.ETag != "" {
		w.Header().Set("ETag", stream.ETag)
	}
	w.Header().Set("Cache-Control", privateRevalidateCacheControl)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if stream.Status == http.StatusNotModified {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	if stream.Status == http.StatusRequestedRangeNotSatisfiable {
		if stream.ContentRange != "" {
			w.Header().Set("Content-Range", stream.ContentRange)
		}
		http.Error(privateAssetResponse{w}, "invalid range", http.StatusRequestedRangeNotSatisfiable)
		return
	}
	if stream.Body == nil {
		serveAssetBytes(w, r, stream.FallbackBytes, stream.MediaType)
		return
	}
	// Large media transfers may outlast the API's default WriteTimeout.
	_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(10 * time.Minute))
	w.Header().Set("Content-Type", stream.MediaType)
	w.Header().Set("Accept-Ranges", "bytes")
	if stream.ContentLength != nil && *stream.ContentLength >= 0 {
		w.Header().Set("Content-Length", strconv.FormatInt(*stream.ContentLength, 10))
	}
	if stream.ContentRange != "" {
		w.Header().Set("Content-Range", stream.ContentRange)
	}
	status := stream.Status
	if status == 0 {
		status = http.StatusOK
	}
	w.WriteHeader(status)
	if _, err := io.Copy(w, stream.Body); err != nil {
		// Never turn a truncated stream into an apparently complete response.
		panic(http.ErrAbortHandler)
	}
}

func serveAssetBytes(w http.ResponseWriter, r *http.Request, body []byte, mediaType string) {
	w.Header().Set("Content-Type", mediaType)
	w.Header().Set("Cache-Control", privateRevalidateCacheControl)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	// Preserve seeking and PDF range reads without issuing a storage redirect.
	http.ServeContent(privateAssetResponse{w}, r, "", time.Time{}, bytes.NewReader(body))
}

type privateAssetResponse struct{ http.ResponseWriter }

func (w privateAssetResponse) WriteHeader(status int) {
	// ServeContent clears cache headers on range errors. Those responses are
	// principal-dependent too and must never become a shared cached result.
	w.Header().Set("Cache-Control", privateRevalidateCacheControl)
	w.ResponseWriter.WriteHeader(status)
}

func (s *Server) storeGeneratedAsset(w http.ResponseWriter, r *http.Request) {
	width, widthErr := strconv.Atoi(r.Header.Get("X-Asset-Width"))
	height, heightErr := strconv.Atoi(r.Header.Get("X-Asset-Height"))
	if widthErr != nil || heightErr != nil {
		writeError(w, http.StatusBadRequest, "invalid asset dimensions")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 50<<20+1)
	body, err := io.ReadAll(r.Body)
	if err != nil || len(body) > 50<<20 {
		writeError(w, http.StatusRequestEntityTooLarge, "asset exceeds 50 MiB")
		return
	}
	asset, err := s.configuration.StoreGeneratedAsset(r.Context(), workspaceActor(r), product.GeneratedAssetInput{
		Body: body, Classification: r.Header.Get("X-Asset-Classification"),
		ContentType: r.Header.Get("Content-Type"), FileName: r.Header.Get("X-Asset-File-Name"),
		Height: height, Width: width, ParentAssetID: r.Header.Get("X-Parent-Asset-ID"),
	})
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, asset)
}
