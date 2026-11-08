import type { CsvRow } from "./csv.js";
import { foldText, isYes, normalizeEmail } from "./normalize.js";

export type User = {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  managerId: string;
  active: boolean;
};

const nameKey = (value: string) => foldText(value).replace(/['’`]/g, "").replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();

export class UserDirectory {
  readonly byId = new Map<string, User>();

  constructor(rows: CsvRow[]) {
    for (const row of rows) {
      const id = (row.id_utente ?? "").trim().toUpperCase();
      if (!id) continue;
      this.byId.set(id, {
        id,
        firstName: (row.nome ?? "").trim(),
        lastName: (row.cognome ?? "").trim(),
        email: normalizeEmail(row.email),
        managerId: (row.responsabile ?? "").trim().toUpperCase(),
        active: isYes(row.attivo),
      });
    }
  }

  private fullName(user: User): string {
    return nameKey(`${user.firstName} ${user.lastName}`);
  }

  // A reference is a user id (U07) or, in some deals, a name: "Rossi M.", "BIANCHI DAVIDE",
  // "A. Verdi". Returns the users it can mean (one person may have two accounts).
  private candidates(ref: string): User[] {
    const trimmed = ref.trim();
    if (!trimmed) return [];
    const direct = this.byId.get(trimmed.toUpperCase());
    if (direct) return [direct];
    const key = nameKey(trimmed);
    if (!key) return [];
    const users = [...this.byId.values()];
    const exact = users.filter((user) => {
      const first = nameKey(user.firstName);
      const last = nameKey(user.lastName);
      return key === `${first} ${last}` || key === `${last} ${first}`;
    });
    if (exact.length) return exact;
    const initial = /^([a-z]) ([a-z ]+)$/.exec(key) ?? null;
    const trailing = /^([a-z ]+) ([a-z])$/.exec(key) ?? null;
    return users.filter((user) => {
      const first = nameKey(user.firstName);
      const last = nameKey(user.lastName);
      if (initial && initial[2] === last && first.startsWith(initial[1]!)) return true;
      if (trailing && trailing[1] === last && first.startsWith(trailing[2]!)) return true;
      return false;
    });
  }

  resolve(ref: string | undefined): User | undefined {
    const found = this.candidates(ref ?? "");
    const people = new Set(found.map((user) => this.fullName(user)));
    if (people.size !== 1) return undefined;
    return found.find((user) => user.active) ?? found[0];
  }

  // Who follows a deal or ticket today: the user if active; else the same person's active
  // account (people who got a new account); else the nearest active manager up the chain.
  currentOwner(ref: string | undefined): User | undefined {
    let user = this.resolve(ref);
    const seen = new Set<string>();
    while (user && !seen.has(user.id)) {
      if (user.active) return user;
      seen.add(user.id);
      const name = this.fullName(user);
      const twin = [...this.byId.values()].find((other) => other.active && this.fullName(other) === name);
      if (twin) return twin;
      user = this.byId.get(user.managerId);
    }
    return undefined;
  }

  ownerEmail(ref: string | undefined): string {
    return this.currentOwner(ref)?.email ?? "";
  }

  // Who wrote an activity: the author as recorded, active or not.
  authorEmail(ref: string | undefined): string {
    return this.resolve(ref)?.email ?? "";
  }
}
