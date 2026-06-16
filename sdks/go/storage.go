package backlex

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
)

// Storage exposes file operations against /api/storage.
type Storage struct {
	client *Client
}

// FileRow describes one stored object.
type FileRow struct {
	Key         string  `json:"key"`
	Size        int64   `json:"size"`
	ContentType string  `json:"contentType,omitempty"`
	OwnerID     *string `json:"ownerId"`
	UploadedAt  string  `json:"uploadedAt"`
}

// List returns stored objects, optionally filtered by key prefix (pass "" for all).
func (s *Storage) List(prefix string) ([]FileRow, error) {
	path := "/api/storage"
	if prefix != "" {
		path += "?prefix=" + url.QueryEscape(prefix)
	}
	var wrap struct {
		Data []FileRow `json:"data"`
	}
	if err := s.client.Do("GET", path, nil, &wrap); err != nil {
		return nil, err
	}
	return wrap.Data, nil
}

// Put uploads bytes under key. Pass contentType/folderID="" to omit them.
func (s *Storage) Put(key string, body []byte, contentType, folderID string) (map[string]any, error) {
	u := s.client.url + "/api/storage/" + url.PathEscape(key)
	if folderID != "" {
		u += "?folderId=" + url.QueryEscape(folderID)
	}
	req, err := http.NewRequest("PUT", u, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	s.client.authHeader(req)

	resp, err := s.client.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		var env errorEnvelope
		raw, _ := io.ReadAll(resp.Body)
		_ = json.Unmarshal(raw, &env)
		return nil, newError(resp.StatusCode, &env)
	}
	var out map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, err
	}
	return out, nil
}

// Download fetches the raw bytes for key.
func (s *Storage) Download(key string) ([]byte, error) {
	req, err := http.NewRequest("GET", s.client.url+"/api/storage/"+url.PathEscape(key), nil)
	if err != nil {
		return nil, err
	}
	s.client.authHeader(req)
	resp, err := s.client.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, newError(resp.StatusCode, nil)
	}
	return io.ReadAll(resp.Body)
}

// Delete removes the object at key.
func (s *Storage) Delete(key string) (*DeleteResult, error) {
	var out DeleteResult
	if err := s.client.Do("DELETE", "/api/storage/"+url.PathEscape(key), nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}
