package ledger

import (
	"errors"
	"fmt"
)

type ledger struct {
	accounts map[string]*account
}

type account struct {
	balance int64
	history []Entry
}

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

func (l *ledger) Record(e Entry) error {
	if e.Amount == 0 {
		return ErrZeroAmount
	}

	acc, ok := l.accounts[e.Account]
	if !ok {
		acc = &account{
			history: []Entry{},
		}
		l.accounts[e.Account] = acc
	}

	newBalance := acc.balance + e.Amount
	if newBalance < 0 {
		return fmt.Errorf("%w: account %q", ErrInsufficient, e.Account)
	}

	acc.balance = newBalance
	acc.history = append(acc.history, e)
	return nil
}

func (l *ledger) Balance(account string) (int64, error) {
	acc, ok := l.accounts[account]
	if !ok {
		return 0, fmt.Errorf("%w: %s", ErrUnknownAccount, account)
	}
	return acc.balance, nil
}

func (l *ledger) History(account string) ([]Entry, error) {
	acc, ok := l.accounts[account]
	if !ok {
		return nil, fmt.Errorf("%w: %s", ErrUnknownAccount, account)
	}
	out := make([]Entry, len(acc.history))
	copy(out, acc.history)
	return out, nil
}
