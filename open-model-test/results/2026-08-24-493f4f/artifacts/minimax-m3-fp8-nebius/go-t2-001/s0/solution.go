package ledger

import (
	"errors"
	"fmt"
)

// ledger is the concrete implementation of the Ledger interface.
type ledger struct {
	balances map[string]int64
	history  map[string][]Entry
}

// NewLedger constructs a new Ledger seeded with the provided starting balances.
// A nil map is treated as an empty map.
func NewLedger(starting map[string]int64) Ledger {
	l := &ledger{
		balances: make(map[string]int64),
		history:  make(map[string][]Entry),
	}
	for account, bal := range starting {
		l.balances[account] = bal
		l.history[account] = nil
	}
	return l
}

// Record applies e atomically: it either commits or changes nothing.
func (l *ledger) Record(e Entry) error {
	if e.Amount == 0 {
		return ErrZeroAmount
	}

	// Compute the post-record balance without mutating state yet.
	current, exists := l.balances[e.Account]
	if !exists {
		current = 0
	}
	newBalance := current + e.Amount
	if newBalance < 0 {
		return fmt.Errorf("%w: account %q", ErrInsufficient, e.Account)
	}

	// Commit: update balance and append to history.
	l.balances[e.Account] = newBalance
	l.history[e.Account] = append(l.history[e.Account], e)
	return nil
}

// Balance returns the account's current balance.
func (l *ledger) Balance(account string) (int64, error) {
	bal, ok := l.balances[account]
	if !ok {
		return 0, fmt.Errorf("%w: %q", ErrUnknownAccount, account)
	}
	return bal, nil
}

// History returns committed entries for account in commit order.
// The returned slice is a copy; mutating it does not affect future calls.
func (l *ledger) History(account string) ([]Entry, error) {
	h, ok := l.history[account]
	if !ok {
		return nil, fmt.Errorf("%w: %q", ErrUnknownAccount, account)
	}
	out := make([]Entry, len(h))
	copy(out, h)
	return out, nil
}

// Compile-time check that ledger satisfies the Ledger interface.
var _ Ledger = (*ledger)(nil)

// Ensure errors.Is works with the wrapped sentinels by re-exporting the
// sentinels here. (They are declared in ledger.go; this file only references
// them and never redeclares them.)
var (
	_ = errors.Is
)
