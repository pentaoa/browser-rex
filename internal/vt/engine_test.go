package vt

import (
	"bytes"
	"context"
	"encoding/base64"
	"image"
	"image/color"
	"image/png"
	"os"
	"strings"
	"testing"
)

func testEngine(t testing.TB) *Engine {
	t.Helper()
	wasm, err := os.ReadFile("../../web/dist/static/js/ghostty-vt.wasm")
	if err != nil {
		t.Fatal("build frontend before VT tests:", err)
	}
	engine, err := NewEngine(context.Background(), wasm)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(engine.Close)
	return engine
}
func TestHeadlessCapture(t *testing.T) {
	engine := testEngine(t)
	state, err := engine.NewTerminal(context.Background(), 40, 5)
	if err != nil {
		t.Fatal(err)
	}
	defer state.Close()
	for _, data := range []string{"hello λ\r\n", "\x1b[1;31mred\x1b[0m <script>\r\n"} {
		if _, err = state.Feed([]byte(data)); err != nil {
			t.Fatal(err)
		}
	}
	text, err := state.Capture("text", true, false)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(text), "hello λ") || !strings.Contains(string(text), "red <script>") {
		t.Fatal(string(text))
	}
	html, err := state.Capture("html", true, false)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(html, []byte("<script>")) || !bytes.Contains(html, []byte("&lt;script&gt;")) {
		t.Fatal(string(html))
	}
	vt, err := state.Capture("vt", true, false)
	if err != nil {
		t.Fatal(err)
	}
	clone, err := engine.NewTerminal(context.Background(), 40, 5)
	if err != nil {
		t.Fatal(err)
	}
	defer clone.Close()
	if _, err = clone.Feed(vt); err != nil {
		t.Fatal(err)
	}
	copied, err := clone.Capture("text", true, false)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(copied, text) {
		t.Fatalf("replay differs:\n%s\n%s", text, copied)
	}
}
func TestRepliesAndMetadata(t *testing.T) {
	engine := testEngine(t)
	state, err := engine.NewTerminal(context.Background(), 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer state.Close()
	if _, err = state.Feed([]byte("\x1b[6")); err != nil {
		t.Fatal(err)
	}
	reply, err := state.Feed([]byte("n"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(reply, []byte("\x1b[1;1R")) {
		t.Fatalf("DSR: %q", reply)
	}
	_, err = state.Feed([]byte("\x1b]0;headless-title\x07\x1b]7;file://localhost/tmp/work\x1b\\\x1b]133;A\x07prompt\r\n\x1b]133;B\x07"))
	if err != nil {
		t.Fatal(err)
	}
	info := state.Info()
	if info.Title != "headless-title" || !strings.Contains(info.PWD, "/tmp/work") || len(info.Prompts) < 2 {
		t.Fatalf("metadata: %+v", info)
	}
	if info.Prompts[0].Line == info.Prompts[1].Line {
		t.Fatal("prompt callbacks did not capture distinct rows")
	}
	for i, frame := range []string{"⠋", "⠹"} {
		if _, err := state.Feed([]byte("\x1b]0;" + frame + " headless-title\x07")); err != nil {
			t.Fatal(err)
		}
		if state.Title() != "⠋ "+info.Title || state.Revision() != info.Revision+1 {
			t.Fatalf("spinner frame %d did not preserve a stable busy title", i)
		}
	}
	if err = state.Resize(93, 31, 8, 16); err != nil {
		t.Fatal(err)
	}
	reply, err = state.Feed([]byte("\x1b[18t"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(reply, []byte("31;93")) {
		t.Fatalf("size reply: %q", reply)
	}
}

func TestProgramReports(t *testing.T) {
	engine := testEngine(t)
	state, err := engine.NewTerminal(context.Background(), 40, 5)
	if err != nil {
		t.Fatal(err)
	}
	defer state.Close()
	_, err = state.Feed([]byte("\x1b]7501;state=blocked:kind=permission:progress=40:id=task:app=agent:title=UGxhbg==:msg=QXBwbHk/\x07"))
	if err != nil {
		t.Fatal(err)
	}
	info := state.Info()
	if len(info.Records) != 1 || info.Records[0].State != "blocked" || info.Records[0].Message != "Apply?" {
		t.Fatalf("status: %+v", info)
	}
	_, err = state.Feed([]byte("\x1b]7501;state=clear:id=task\x1b\\"))
	if err != nil {
		t.Fatal(err)
	}
	if len(state.Info().Records) != 0 {
		t.Fatal("clear did not remove record")
	}
}
func TestHTMLLinkPolicy(t *testing.T) {
	engine := testEngine(t)
	state, err := engine.NewTerminal(context.Background(), 40, 5)
	if err != nil {
		t.Fatal(err)
	}
	defer state.Close()
	state.Feed([]byte("\x1b]8;;javascript:alert(1)\x1b\\CLICK\x1b]8;;\x1b\\"))
	html, err := state.Capture("html", true, false)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(html), "href=\"javascript:") || !strings.Contains(string(html), "Content-Security-Policy") {
		t.Fatal(string(html))
	}
}

func TestResetClearsMetadata(t *testing.T) {
	engine := testEngine(t)
	state, err := engine.NewTerminal(context.Background(), 40, 5)
	if err != nil {
		t.Fatal(err)
	}
	defer state.Close()
	_, err = state.Feed([]byte("\x1b]7501;state=working:id=task\x07\x1b]133;A\x07"))
	if err != nil {
		t.Fatal(err)
	}
	_, err = state.Feed([]byte("\x1bc"))
	if err != nil {
		t.Fatal(err)
	}
	if len(state.Info().Records) != 0 || len(state.Info().Prompts) != 0 {
		t.Fatal("reset retained stale metadata")
	}
}

func TestServerPNGDecoderAcknowledgesImages(t *testing.T) {
	engine := testEngine(t)
	state, err := engine.NewTerminal(context.Background(), 40, 5)
	if err != nil {
		t.Fatal(err)
	}
	defer state.Close()
	picture := image.NewNRGBA(image.Rect(0, 0, 1, 1))
	picture.SetNRGBA(0, 0, color.NRGBA{R: 255, A: 255})
	var encoded bytes.Buffer
	if err := png.Encode(&encoded, picture); err != nil {
		t.Fatal(err)
	}
	command := "\x1b_Ga=T,f=100,i=1,s=1,v=1,c=1,r=1;" + base64.StdEncoding.EncodeToString(encoded.Bytes()) + "\x1b\\"
	reply, err := state.Feed([]byte(command))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(reply, []byte("OK")) {
		t.Fatalf("PNG acknowledgement: %q", reply)
	}
}

func TestSharedEngineKeepsTerminalStateIsolated(t *testing.T) {
	engine := testEngine(t)
	for _, label := range []string{"first", "second"} {
		t.Run(label, func(t *testing.T) {
			t.Parallel()
			state, err := engine.NewTerminal(context.Background(), 80, 24)
			if err != nil {
				t.Fatal(err)
			}
			defer state.Close()
			for _, chunk := range [][]byte{
				[]byte("\x1b]0;" + label + "\x07"),
				bytes.Repeat([]byte("padding\r\n"), 6000),
				[]byte(label + " marker\r\n"),
			} {
				if _, err := state.Feed(chunk); err != nil {
					t.Fatal(err)
				}
			}
			text, err := state.Capture("text", true, false)
			if err != nil || !bytes.Contains(text, []byte(label+" marker")) || state.Info().Title != label {
				t.Fatalf("terminal lost its title or marker after feed buffer growth: %v", err)
			}
			if bytes.Contains(text, []byte("first marker")) == bytes.Contains(text, []byte("second marker")) {
				t.Fatal("terminal output was shared across instances")
			}
		})
	}
}
