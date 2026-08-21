package ledger

import "fmt"

// account holds the state for a single account.
type account struct {
	balance int64
	history []Entry
}

// ledgerImpl implements the Ledger interface.
type ledgerImpl struct {
	accounts map[string]*account
}

// NewLedger creates a new Ledger seeded with the given starting balances.
// A nil starting map yields an empty ledger.
func NewLedger(starting map[string]int64) Ledger {
	l := &ledgerImpl{
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
func (l *ledgerImpl) Record(e Entry) error {
	if e.Amount == 0 {
		return fmt.Errorf("%w", ErrZeroAmount)
	}

	acc, exists := l.accounts[e.Account]
	var current int64
	if exists {
		current = acc.balance
	} else {
		current = 0
	}

	newBalance := current + e.Amount
	if newBalance < 0 {
		return fmt.Errorf("%w", ErrInsufficient)
	}

	if !exists {
		// Create the account with the new balance and the entry as its first history item.
		l.accounts[e.Account] = &account{
			balance: newBalance,
			history: []Entry{e},
		}
	} else {
		acc.balance = newBalance
		acc.history = append(acc.history, e)
	}
	return nil
}

// Balance returns the account's current balance.
func (l *ledgerImpl) Balance(account string) (int64, error) {
	acc, ok := l.accounts[account]
	if !ok {
		return 0, fmt.Errorf("%w", ErrUnknownAccount)
	}
	return acc.balance, nil
}

// History returns committed entries for account in commit order.
// The returned slice is a copy; mutating it does not affect the ledger.
func (l *ledgerImpl) History(account string) ([]Entry, error) {
	acc, ok := l.accounts[account]
	if !ok {
		return nil, fmt.Errorf("%w", ErrUnknownAccount)
	}
	// Return a defensive copy.
	hist := make([]Entry, len(acc.history))
	copy(hist, acc.history)
	return hist, nil
}
