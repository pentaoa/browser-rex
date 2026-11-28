package remote

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pentaoa/browser-rex/internal/workspace"
)

const uploadProtocol = "rex.data.bytes.v1"

func uploadReference() string {
	var id [16]byte
	rand.Read(id[:])
	id[6] = id[6]&0x0f | 0x40
	id[8] = id[8]&0x3f | 0x80
	return fmt.Sprintf("upload:%x-%x-%x-%x-%x", id[:4], id[4:6], id[6:8], id[8:10], id[10:])
}

func (c *control) supportsUpload(ctx context.Context) bool {
	if c.uploads != nil {
		return *c.uploads
	}
	var response struct {
		Creators []struct {
			Name string
			API  struct {
				Methods map[string]json.RawMessage
			}
		}
	}
	if c.callContext(ctx, "block_creator.list", fields{}, &response) != nil {
		return false
	}
	supported := false
	for _, creator := range response.Creators {
		if creator.Name == terminalCreator {
			_, supported = creator.API.Methods["upload_begin"]
			break
		}
	}
	c.uploads = &supported
	return supported
}

func (m *Manager) upload(w http.ResponseWriter, r *http.Request, h Host) {
	if m.uploads == nil {
		failure(w, 403, "uploads are disabled on this service")
		return
	}
	session, block := r.URL.Query().Get("session"), r.URL.Query().Get("block")
	if session == "" || block == "" {
		failure(w, 400, "a session and terminal pane are required")
		return
	}
	select {
	case m.uploads <- struct{}{}:
		defer func() { <-m.uploads }()
	default:
		failure(w, 503, "upload concurrency limit reached")
		return
	}

	pool, err := m.pool(h)
	if err != nil {
		failure(w, 404, err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Minute)
	defer cancel()
	stopHost := context.AfterFunc(pool.ctx, cancel)
	defer stopHost()
	deadline, _ := ctx.Deadline()
	controller := http.NewResponseController(w)
	controller.SetReadDeadline(deadline)
	controller.SetWriteDeadline(deadline.Add(10 * time.Second))

	const maxRequest = workspace.MaxUploadBytes + (64 << 10)
	if r.ContentLength > maxRequest {
		failure(w, 413, "upload exceeds 16 MiB")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxRequest)
	reader, err := r.MultipartReader()
	if err != nil {
		failure(w, 400, "expected a multipart upload")
		return
	}
	part, err := reader.NextPart()
	if err != nil || part.FormName() != "file" || part.FileName() == "" || len(part.FileName()) > 512 {
		failure(w, 400, "expected one named file")
		return
	}
	name := part.FileName()
	// The Rex ticket requires the exact length. Validate the complete bounded
	// request before reserving an upstream upload or touching the terminal.
	spool, err := os.CreateTemp("", "browser-rex-upload-*")
	if err != nil {
		failure(w, 500, "could not stage upload")
		return
	}
	defer os.Remove(spool.Name())
	defer spool.Close()
	size, err := io.Copy(spool, io.LimitReader(part, workspace.MaxUploadBytes+1))
	if size > workspace.MaxUploadBytes {
		failure(w, 413, "upload exceeds 16 MiB")
		return
	}
	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		failure(w, 413, "upload exceeds 16 MiB")
		return
	}
	if err != nil {
		failure(w, 400, "incomplete upload")
		return
	}
	if _, err := reader.NextPart(); err != io.EOF {
		failure(w, 400, "expected exactly one file")
		return
	}
	if _, err := spool.Seek(0, io.SeekStart); err != nil {
		failure(w, 500, "could not read staged upload")
		return
	}

	c, err := connect(ctx, h)
	if err != nil {
		failure(w, 502, err.Error())
		return
	}
	defer c.Close()
	if !c.supportsUpload(ctx) {
		failure(w, 400, "the selected Rex server does not support terminal uploads")
		return
	}
	if err := c.callContext(ctx, "session.attach", fields{"session_id": session}, nil); err != nil {
		failure(w, 502, "could not attach to the upload's session")
		return
	}
	var reservation struct{ Ticket string }
	err = c.callContext(ctx, terminalCreator+".upload_begin", fields{
		"session_id": session, "block_id": block,
		"args": fields{"ref": uploadReference(), "name": name, "size": size},
	}, &reservation)
	if err != nil {
		failure(w, 502, "Rex refused the upload: "+err.Error())
		return
	}
	if err := sendUpload(ctx, h, reservation.Ticket, spool); err != nil {
		failure(w, 502, err.Error())
		return
	}
	reply(w, 200, fields{"display_name": name, "inserted": true})
}

func sendUpload(ctx context.Context, h Host, ticket string, file io.Reader) error {
	token, err := base64.RawURLEncoding.DecodeString(ticket)
	if err != nil || len(token) != 16 {
		return errors.New("invalid Rex upload ticket")
	}
	ws, err := openSocket(ctx, h, "/api/data", uploadProtocol)
	if err != nil {
		return err
	}
	defer ws.Close()
	stop := context.AfterFunc(ctx, func() { ws.Close() })
	defer stop()
	ws.SetReadLimit(65536)
	ws.SetWriteDeadline(time.Now().Add(5 * time.Second))
	ws.SetReadDeadline(time.Now().Add(5 * time.Second))
	if err := ws.WriteMessage(websocket.BinaryMessage, append([]byte{1}, token...)); err != nil {
		return errors.New("Rex upload handshake failed")
	}
	kind, welcome, err := ws.ReadMessage()
	if err != nil || kind != websocket.BinaryMessage || len(welcome) != 32 || welcome[0] != 0x81 {
		return errors.New("Rex upload handshake rejected")
	}
	deadline, _ := ctx.Deadline()
	ws.SetReadDeadline(deadline)
	result := make(chan error, 1)
	go func() {
		ended := false
		for {
			kind, data, err := ws.ReadMessage()
			if err != nil {
				var closed *websocket.CloseError
				if errors.As(err, &closed) && closed.Code == websocket.CloseNormalClosure && strings.TrimSpace(closed.Text) == "" {
					result <- nil
				} else {
					result <- errors.New("Rex did not confirm the upload; check the target pane before retrying")
				}
				return
			}
			if kind != websocket.BinaryMessage || len(data) != 0 || ended {
				result <- errors.New("unexpected data on the Rex upload stream")
				return
			}
			ended = true
		}
	}()
	buf := make([]byte, 64<<10)
	for {
		n, err := file.Read(buf)
		if n > 0 {
			ws.SetWriteDeadline(time.Now().Add(5 * time.Second))
			if ws.WriteMessage(websocket.BinaryMessage, buf[:n]) != nil {
				return errors.New("Rex upload stream interrupted")
			}
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return errors.New("could not read staged upload")
		}
	}
	ws.SetWriteDeadline(time.Now().Add(5 * time.Second))
	if ws.WriteMessage(websocket.BinaryMessage, nil) != nil {
		return errors.New("Rex upload stream interrupted")
	}
	return <-result
}
