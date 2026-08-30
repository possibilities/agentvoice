# Reservation ledger

This tiny library tracks stock reservations for an at-least-once request
consumer. Its public contract is:

- positive reservations reduce available stock;
- insufficient stock is rejected without mutation;
- `request_id` makes a successful request idempotent across delivery retries;
- reusing a request ID for a different reservation is a caller error.

Run the public suite with:

```bash
python3 -m unittest discover -s tests -v
```
