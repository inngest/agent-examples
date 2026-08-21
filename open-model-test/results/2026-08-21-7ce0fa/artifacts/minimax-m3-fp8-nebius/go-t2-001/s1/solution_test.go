package ledger

import (
	"errors"
	"reflect"
	"testing"
)

func newSeeded() Ledger {
	return NewLedger(map[string]int64{"alice": 100, "bob": 40})
}

func TestSeededBalances(t *testing.T) {
	l := newSeeded()
	for acct, want := range map[string]int64{"alice": 100, "bob": 40} {
		got, err := l.Balance(acct)
		if err != nil || got != want {
			t.Errorf("Balance(%q) = %d, %v; want %d, nil", acct, got, err, want)
		}
	}
}

func TestUnknownAccountBalance(t *testing.T) {
	l := newSeeded()
	if _, err := l.Balance("carol"); !errors.Is(err, ErrUnknownAccount) {
		t.Errorf("Balance(unknown) err = %v; want ErrUnknownAccount", err)
	}
}

func TestUnknownAccountHistory(t *testing.T) {
	l := newSeeded()
	if _, err := l.History("carol"); !errors.Is(err, ErrUnknownAccount) {
		t.Errorf("History(unknown) err = %v; want ErrUnknownAccount", err)
	}
}

func TestSeededEmptyHistory(t *testing.T) {
	l := newSeeded()
	h, err := l.History("alice")
	if err != nil {
		t.Fatalf("History(seeded) err = %v", err)
	}
	if len(h) != 0 {
		t.Errorf("History(seeded, no entries) len = %d; want 0", len(h))
	}
}

func TestDepositCreatesAccount(t *testing.T) {
	l := newSeeded()
	if err := l.Record(Entry{Account: "carol", Amount: 5, Tag: "in"}); err != nil {
		t.Fatalf("Record(deposit new) err = %v", err)
	}
	got, err := l.Balance("carol")
	if err != nil || got != 5 {
		t.Errorf("Balance(new) = %d, %v; want 5, nil", got, err)
	}
}

func TestWithdrawUpdatesBalance(t *testing.T) {
	l := newSeeded()
	if err := l.Record(Entry{Account: "alice", Amount: -30, Tag: "out"}); err != nil {
		t.Fatalf("Record err = %v", err)
	}
	got, err := l.Balance("alice")
	if err != nil || got != 70 {
		t.Errorf("Balance = %d, %v; want 70, nil", got, err)
	}
}

func TestOverdraftRejectedAtomically(t *testing.T) {
	l := newSeeded()
	err := l.Record(Entry{Account: "bob", Amount: -41, Tag: "out"})
	if !errors.Is(err, ErrInsufficient) {
		t.Fatalf("Record(overdraft) err = %v; want ErrInsufficient", err)
	}
	got, err2 := l.Balance("bob")
	if err2 != nil || got != 40 {
		t.Errorf("Balance after rejected overdraft = %d, %v; want 40, nil", got, err2)
	}
	h, _ := l.History("bob")
	if len(h) != 0 {
		t.Errorf("History after rejected overdraft len = %d; want 0", len(h))
	}
}

func TestOverdraftOnUnknownIsInsufficient(t *testing.T) {
	l := NewLedger(nil)
	err := l.Record(Entry{Account: "nobody", Amount: -1})
	if !errors.Is(err, ErrInsufficient) {
		t.Errorf("Record(withdraw unknown) err = %v; want ErrInsufficient (balance 0)", err)
	}
}

func TestZeroAmountRejected(t *testing.T) {
	l := newSeeded()
	if err := l.Record(Entry{Account: "alice", Amount: 0}); !errors.Is(err, ErrZeroAmount) {
		t.Errorf("Record(zero) err = %v; want ErrZeroAmount", err)
	}
}

func TestHistoryCommitOrder(t *testing.T) {
	l := NewLedger(nil)
	l.Record(Entry{Account: "a", Amount: 1, Tag: "one"})
	l.Record(Entry{Account: "a", Amount: 2, Tag: "two"})
	l.Record(Entry{Account: "b", Amount: 3, Tag: "three"})
	l.Record(Entry{Account: "a", Amount: 4, Tag: "four"})
	h, err := l.History("a")
	if err != nil {
		t.Fatalf("History err = %v", err)
	}
	want := []Entry{
		{Account: "a", Amount: 1, Tag: "one"},
		{Account: "a", Amount: 2, Tag: "two"},
		{Account: "a", Amount: 4, Tag: "four"},
	}
	if !reflect.DeepEqual(h, want) {
		t.Errorf("History = %v; want %v", h, want)
	}
}

func TestHistoryReturnsCopy(t *testing.T) {
	l := NewLedger(nil)
	l.Record(Entry{Account: "a", Amount: 1})
	h1, _ := l.History("a")
	if len(h1) > 0 {
		h1[0] = Entry{Account: "hacked", Amount: 999}
	}
	h2, _ := l.History("a")
	if len(h2) != 1 || h2[0].Account != "a" || h2[0].Amount != 1 {
		t.Errorf("History mutation leaked: %v", h2)
	}
}

func TestExactZeroBalanceAfterWithdrawal(t *testing.T) {
	l := NewLedger(map[string]int64{"x": 10})
	if err := l.Record(Entry{Account: "x", Amount: -10}); err != nil {
		t.Fatalf("Record(to exactly zero) err = %v", err)
	}
	got, err := l.Balance("x")
	if err != nil || got != 0 {
		t.Errorf("Balance = %d, %v; want 0, nil", got, err)
	}
}
