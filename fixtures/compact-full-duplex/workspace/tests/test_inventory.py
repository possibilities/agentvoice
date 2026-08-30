import unittest

from inventory import Inventory, Reservation


class InventoryTests(unittest.TestCase):
    def test_reservation_reduces_available_stock(self) -> None:
        inventory = Inventory({"desk": 5})

        reservation = inventory.reserve("req-1", "desk", 2)

        self.assertEqual(reservation, Reservation("req-1", "desk", 2))
        self.assertEqual(inventory.available("desk"), 3)
        self.assertEqual(inventory.reservation("req-1"), reservation)

    def test_insufficient_stock_does_not_mutate_inventory(self) -> None:
        inventory = Inventory({"desk": 1})

        with self.assertRaisesRegex(ValueError, "insufficient stock"):
            inventory.reserve("req-1", "desk", 2)

        self.assertEqual(inventory.available("desk"), 1)
        self.assertIsNone(inventory.reservation("req-1"))

    def test_quantity_must_be_positive(self) -> None:
        inventory = Inventory({"desk": 3})

        with self.assertRaisesRegex(ValueError, "quantity must be positive"):
            inventory.reserve("req-1", "desk", 0)

        self.assertEqual(inventory.available("desk"), 3)


if __name__ == "__main__":
    unittest.main()
