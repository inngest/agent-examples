package ledger

import "fmt"

type accountData struct {
	balance int64
	history []Entry
	known   bool
}

type simpleLedger struct {
	accounts map[string]*accountData
}

// NewLedger creates a new Ledger, optionally seeded with starting balances.
func NewLedger(starting map[string]int64) Ledger {
	l := &simpleLedger{accounts: make(map[string]*accountData)}
	for acct, bal := range starting {
		l.accounts[acct] = &accountData{
			balance: bal,
			history: nil,
			known:   true,
		}
	}
	return l
}

func (l *simpleLedger) Record(e Entry) error {
	if e.Amount == 0 {
		return ErrZeroAmount
	}

	acc, exists := l.accounts[e.Account]
	if !exists {
		acc = &accountData{known: true}
		l.accounts[e.Account] = acc
	}

	newBalance := acc.balance + e.Amount
	if newBalance < 0 {
		return fmt.Errorf("record entry %+v: %w", e, ErrInsufficient)
	}

	acc.balance = newBalance
	acc.history = append(acc.history, e)
	acc.known = true

	return nil
}

func (l *simpleLedger) Balance(account string) (int64, error) {
	acc, exists := l.accounts[account]
	if !exists || !acc.known {
		return 0, fmt.Errorf("balance for %q: %w", account, ErrUnknownAccount)
	}
	return acc.balance, nil
}

func (l *simpleLedger) History(account string) ([]Entry, error) {
	acc, exists := l.accounts[account]
	if !exists || !acc.known {
		return nil, fmt.Errorf("history for %q: %w", account, ErrUnknownAccount)
	}
	histCopy := make([]Entry, len(acc.history))
	copy(histCopy, acc.history)
	return histCopy, nil
}
