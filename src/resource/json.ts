export type JsonObject = Record<string, unknown>;

export function isObject(value: unknown): value is JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

/** Structural equality for JSON values; object key order is ignored, array order is not. */
export function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left)) {
    return (
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => deepEqual(value, right[index]))
    );
  }
  if (isObject(left) && isObject(right)) {
    const leftKeys = Object.keys(left).filter((key) => left[key] !== undefined);
    const rightKeys = Object.keys(right).filter((key) => right[key] !== undefined);
    return leftKeys.length === rightKeys.length && leftKeys.every((key) => deepEqual(left[key], right[key]));
  }
  return false;
}

/** A deep copy of a JSON value. */
export function cloneJson<T>(value: T): T {
  return structuredClone(value);
}

/** Keys that would modify Object.prototype when assigned with bracket notation. */
export const UNSAFE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);
