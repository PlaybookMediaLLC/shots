package publicnet

import (
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"syscall"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/telemetry"
)

// ErrBlocked marks a dial refused because the address is not public.
var ErrBlocked = errors.New("blocked destination")

// Transport dials only public addresses. The check runs on the address
// actually dialed, after DNS, so rebinding cannot reach a private one, and
// it applies again to every redirect hop. It uses no environment proxy and
// sends no trace headers to customer hosts.
func Transport() *http.Transport {
	dialer := &net.Dialer{Timeout: 5 * time.Second, Control: func(_, address string, _ syscall.RawConn) error {
		host, _, err := net.SplitHostPort(address)
		if err != nil {
			return err
		}
		parsed, err := netip.ParseAddr(host)
		if err != nil || !IsPublic(parsed) {
			return fmt.Errorf("%w: %s", ErrBlocked, host)
		}
		return nil
	}}
	transport := telemetry.UntracedTransport.Clone()
	transport.Proxy = nil
	transport.DialContext = dialer.DialContext
	transport.MaxResponseHeaderBytes = 16 << 10
	return transport
}
