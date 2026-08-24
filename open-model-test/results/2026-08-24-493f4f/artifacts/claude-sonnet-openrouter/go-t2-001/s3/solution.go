package ledger

import "fmt"

type ledgerImpl struct {
	balances map[string]int64
	history  map[string][]Entry
	known    map[string]bool
}

// NewLedger creates a new Ledger, seeding starting balances for the
// provided accounts.
func NewLedger(starting map[string]int64) Ledger {
	l := &ledgerImpl{
		balances: make(map[string]int64),
		history:  make(map[string][]Entry),
		known:    make(map[string]bool),
	}
	for acc, bal := range starting {
		l.balances[acc] = bal
		l.known[acc] = true
	}
	return l
}

func (l *ledgerImpl) Record(e Entry) error {
	if e.Amount == 0 {
		return ErrZeroAmount
	}
	newBal := l.balances[e.Account] + e.Amount
	if newBal < 0 {
		return fmt.Errorf("ledger: record %+v: %w", e, ErrInsufficient)
	}
	l.balances[e.Account] = newBal
	l.known[e.Account] = true
	l.history[e.Account] = append(l.history[e.Account], e)
	return nil
}

func (l *ledgerImpl) Balance(account string) (int64, error) {
	if !l.known[account] {
		return 0, fmt.Errorf("ledger: account %q: %w", account, ErrUnknownAccount)
	}
	return l.balances[account], nil
}

func (l *ledgerImpl) History(account string) ([]Entry, error) {
	if !l.known[account] {
		return nil, fmt.Errorf("ledger: account %q: %w", account, ErrUnknownAccount)
	}
	src := l.history[account]
	out := make([]Entry, len(src))
	copy(out, src)
	return out, nil
}
