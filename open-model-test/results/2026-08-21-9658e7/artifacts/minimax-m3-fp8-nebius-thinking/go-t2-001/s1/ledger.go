package ledger

import "errors"

type Entry struct {
	Account string
	Amount  int64 // positive = deposit, negative = withdrawal
	Tag     string
}

var (
	ErrUnknownAccount = errors.New("ledger: unknown account")
	ErrInsufficient   = errors.New("ledger: insufficient funds")
	ErrZeroAmount     = errors.New("ledger: zero amount")
)

type Ledger interface {
	// Record applies e atomically: it either commits or changes nothing.
	Record(e Entry) error
	// Balance returns the account's current balance.
	Balance(account string) (int64, error)
	// History returns committed entries for account in commit order.
	History(account string) ([]Entry, error)
}
