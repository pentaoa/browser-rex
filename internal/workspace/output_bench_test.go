package workspace

import "testing"

func BenchmarkPaneReplay(b *testing.B) {
	p := &pane{}
	data := make([]byte, 16<<10)
	for i := 0; i < 33; i++ {
		p.publish(data)
	}
	b.ReportAllocs()
	b.SetBytes(512 << 10)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		a, err := p.attach(-1)
		if err != nil {
			b.Fatal(err)
		}
		p.detach(a)
	}
}

func BenchmarkPaneLiveOutput(b *testing.B) {
	p := &pane{}
	data := make([]byte, 4096)
	a, err := p.attach(-1)
	if err != nil {
		b.Fatal(err)
	}
	defer p.detach(a)
	b.ReportAllocs()
	b.SetBytes(int64(len(data)))
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		p.publish(data)
		<-a.live
	}
}
