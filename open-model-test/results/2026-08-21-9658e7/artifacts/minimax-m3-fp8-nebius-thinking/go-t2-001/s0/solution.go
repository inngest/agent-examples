package ledger

import "fmt"

// ledger is the concrete implementation of the Ledger interface.
type ledger struct {
	balances map[string]int64
	history  map[string][]Entry
}

// NewLedger returns a new Ledger seeded with the provided starting balances.
// A nil starting map yields an empty ledger.
func NewLedger(starting map[string]int64) Ledger {
	l := &ledger{
		balances: make(map[string]int64),
		history:  make(map[string][]Entry),
	}
	for acc, bal := range starting {
		l.balances[acc] = bal
		// Initialize history slice for seeded accounts.
		l.history[acc] = []Entry{}
	}
	return l
}

// Record applies e atomically: it either commits or changes nothing.
func (l *ledger) Record(e Entry) error {
	if e.Amount == 0 {
		return ErrZeroAmount
	}
	cur, ok := l.balances[e.Account]
	if !ok {
		cur = 0
	}
	newBal := cur + e.Amount
	if newBal < 0 {
		// Wrap sentinel with context for better debugging.
		return fmt.Errorf("%w: account %s", ErrInsufficient, e.Account)
	}
	// Commit: update balance and append to history.
	l.balances[e.Account] = newBal
	hist := l.history[e.Account]
	if hist == nil {
		hist = []Entry{}
	}
	hist = append(hist, e)
	l.history[e.Account] = hist
	return nil
}

// Balance returns the account's current balance.
func (l *ledger) Balance(account string) (int64, error) {
	bal, ok := l.balances[account]
	if !ok {
		return 0, fmt.Errorf("%w: %s", ErrUnknownAccount, account)
	}
	return bal, nil
}

// History returns committed entries for account in commit order.
// It returns a copy of the internal slice.
func (l *ledger) History(account string) ([]Entry, error) {
	hist, ok := l.history[account]
	if !ok {
		return nil, fmt.Errorf("%w: %s", ErrUnknownAccount, account)
	}
	// Return a copy to prevent external mutation.
	out := make([]Entry, len(hist))
	copy(out, hist)
	return out, nil
}
