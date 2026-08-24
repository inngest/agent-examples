package ledger

import (
	"errors"
	"fmt"
)

// ledger is the concrete implementation of the Ledger interface.
type ledger struct {
	accounts map[string]*account
}

// account holds the balance and history for a single account.
type account struct {
	balance int64
	history []Entry
}

// NewLedger creates a new Ledger seeded with the provided starting balances.
// A nil map is treated as an empty map.
func NewLedger(starting map[string]int64) Ledger {
	l := &ledger{
		accounts: make(map[string]*account),
	}
	for name, bal := range starting {
		l.accounts[name] = &account{
			balance: bal,
			history: []Entry{},
		}
	}
	return l
}

// Record applies e atomically: it either commits or changes nothing.
func (l *ledger) Record(e Entry) error {
	if e.Amount == 0 {
		return ErrZeroAmount
	}

	acc, ok := l.accounts[e.Account]
	if !ok {
		// Create the account if it doesn't exist.
		acc = &account{
			balance: 0,
			history: []Entry{},
		}
		l.accounts[e.Account] = acc
	}

	newBalance := acc.balance + e.Amount
	if newBalance < 0 {
		return fmt.Errorf("%w: account %q balance %d, withdrawal %d", ErrInsufficient, e.Account, acc.balance, -e.Amount)
	}

	// Commit the entry.
	acc.balance = newBalance
	acc.history = append(acc.history, e)
	return nil
}

// Balance returns the account's current balance.
func (l *ledger) Balance(account string) (int64, error) {
	acc, ok := l.accounts[account]
	if !ok {
		return 0, fmt.Errorf("%w: %q", ErrUnknownAccount, account)
	}
	return acc.balance, nil
}

// History returns committed entries for account in commit order.
// The returned slice is a copy; mutating it does not affect subsequent calls.
func (l *ledger) History(account string) ([]Entry, error) {
	acc, ok := l.accounts[account]
	if !ok {
		return nil, fmt.Errorf("%w: %q", ErrUnknownAccount, account)
	}
	// Return a copy of the history slice.
	out := make([]Entry, len(acc.history))
	copy(out, acc.history)
	return out, nil
}
