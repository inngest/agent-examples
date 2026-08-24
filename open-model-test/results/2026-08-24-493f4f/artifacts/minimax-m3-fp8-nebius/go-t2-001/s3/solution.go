package ledger

import (
	"errors"
	"fmt"
)

// ledger is the concrete implementation of the Ledger interface.
type ledger struct {
	accounts map[string]*account
}

// account holds the state for a single account.
type account struct {
	balance int64
	history []Entry
}

// NewLedger creates a new Ledger seeded with the provided starting balances.
// Passing nil yields an empty ledger.
func NewLedger(starting map[string]int64) Ledger {
	l := &ledger{
		accounts: make(map[string]*account),
	}
	for name, bal := range starting {
		l.accounts[name] = &account{
			balance: bal,
			history: nil,
		}
	}
	return l
}

// Record applies e atomically: it either commits or changes nothing.
func (l *ledger) Record(e Entry) error {
	if e.Amount == 0 {
		return ErrZeroAmount
	}

	acct, exists := l.accounts[e.Account]
	if !exists {
		acct = &account{}
		l.accounts[e.Account] = acct
	}

	newBalance := acct.balance + e.Amount
	if newBalance < 0 {
		return fmt.Errorf("%w: account %q", ErrInsufficient, e.Account)
	}

	acct.balance = newBalance
	acct.history = append(acct.history, e)
	return nil
}

// Balance returns the account's current balance.
func (l *ledger) Balance(account string) (int64, error) {
	acct, exists := l.accounts[account]
	if !exists {
		return 0, fmt.Errorf("%w: %q", ErrUnknownAccount, account)
	}
	return acct.balance, nil
}

// History returns committed entries for account in commit order.
// The returned slice is a copy; mutating it does not affect future calls.
func (l *ledger) History(account string) ([]Entry, error) {
	acct, exists := l.accounts[account]
	if !exists {
		return nil, fmt.Errorf("%w: %q", ErrUnknownAccount, account)
	}
	out := make([]Entry, len(acct.history))
	copy(out, acct.history)
	return out, nil
}
