export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

export function isValidPhone(phone: string): boolean {
  return /^\+?[\d\s-]{10,15}$/.test(phone)
}

export function isWithinCapacity(booked: number, capacity: number | null): boolean {
  if (capacity === null) return true
  return booked < capacity
}
