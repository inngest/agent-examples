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

	acct, exists := l.accounts[e.Account]
	if !exists {
		acct = &account{
			balance: 0,
			history: []Entry{},
		}
		l.accounts[e.Account] = acct
	}

	newBalance := acct.balance + e.Amount
	if newBalance < 0 {
		return fmt.Errorf("%w: account %q balance %d, withdrawal %d", ErrInsufficient, e.Account, acct.balance, -e.Amount)
	}

	acct.balance = newBalance
	acct.history = append(acct.history, e)
	return nil
}

func (l *ledger) Balance(account string) (int64, error) {
	acct, exists := l.accounts[account]
	if !exists {
		return 0, fmt.Errorf("%w: %q", ErrUnknownAccount, account)
	}
	return acct.balance, nil
}

func (l *ledger) History(account string) ([]Entry, error) {
	acct, exists := l.accounts[account]
	if !exists {
		return nil, fmt.Errorf("%w: %q", ErrUnknownAccount, account)
	}
	out := make([]Entry, len(acct.history))
	copy(out, acct.history)
	return out, nil
}
