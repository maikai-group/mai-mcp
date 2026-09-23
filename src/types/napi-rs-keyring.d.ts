// Narrow v2.1.0 surface for builds omitting optional native dependencies.
// This ambient declaration can shadow installed types; runtime import/OS smoke
// evidence is separate from successful compilation (see provider plan Task2).
declare module '@napi-rs/keyring' {
  export class Entry {
    constructor(service: string, username: string, options?: { linux?: { store?: 'secret-service' | 'keyutils' } });
    getPassword(): string | null;
    setPassword(password: string): void;
  }
}
