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
	balances := make(map[string]int64, len(starting))
	history := make(map[string][]Entry, len(starting))
	for account, bal := range starting {
		balances[account] = bal
		history[account] = nil
	}
	return &ledger{
		balances: balances,
		history:  history,
	}
}

// Record applies e atomically: it either commits or changes nothing.
func (l *ledger) Record(e Entry) error {
	if e.Amount == 0 {
		return ErrZeroAmount
	}

	current, exists := l.balances[e.Account]
	newBalance := current + e.Amount
	if newBalance < 0 {
		return fmt.Errorf("%w: account %q balance %d, attempted %d",
			ErrInsufficient, e.Account, current, e.Amount)
	}

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
	hist, ok := l.history[account]
	if !ok {
		return nil, fmt.Errorf("%w: %q", ErrUnknownAccount, account)
	}
	out := make([]Entry, len(hist))
	copy(out, hist)
	return out, nil
}
