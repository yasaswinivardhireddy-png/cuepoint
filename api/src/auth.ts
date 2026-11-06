import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { Advertiser, Principal } from './domain.ts';

export const ADVERTISERS: Advertiser[] = [
  { id: 'adv-acme-motors', name: 'Acme Motors' },
  { id: 'adv-zephyr-motors', name: 'Zephyr Motors' },
  { id: 'adv-bluepeak', name: 'Bluepeak Beverages' },
  { id: 'adv-summit', name: 'Summit Insurance' },
  { id: 'adv-orbit', name: 'Orbit Telecom' },
];

// Demo accounts share one password from configuration; a real deployment would use an identity provider.
const DEMO_USERS: { email: string; name: string; role: Principal['role']; advertiserId?: string }[] = [
  { email: 'admin@cuepoint.dev', name: 'Ad Operations', role: 'admin' },
  { email: 'ads@acmemotors.example', name: 'Acme Motors', role: 'advertiser', advertiserId: 'adv-acme-motors' },
  { email: 'ads@bluepeak.example', name: 'Bluepeak Beverages', role: 'advertiser', advertiserId: 'adv-bluepeak' },
];

const hash = (password: string, salt: Buffer) =>
  new Promise<Buffer>((resolve, reject) => scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 }, (err, key) => (err ? reject(err) : resolve(key))));

interface StoredUser {
  principal: Principal;
  salt: Buffer;
  hash: Buffer;
}

export class UserDirectory {
  private readonly users = new Map<string, StoredUser>();
  private dummy: StoredUser | undefined;

  static async create(demoPassword: string): Promise<UserDirectory> {
    const dir = new UserDirectory();
    for (const u of DEMO_USERS) {
      const salt = randomBytes(16);
      dir.users.set(u.email, {
        principal: { sub: u.email, name: u.name, role: u.role, ...(u.advertiserId ? { adv: u.advertiserId } : {}) },
        salt,
        hash: await hash(demoPassword, salt),
      });
    }
    const salt = randomBytes(16);
    dir.dummy = { principal: { sub: '', name: '', role: 'advertiser' }, salt, hash: await hash(randomBytes(16).toString('hex'), salt) };
    return dir;
  }

  /** Unknown emails still pay for one scrypt, so response time does not reveal which accounts exist. */
  async verify(email: string, password: string): Promise<Principal | undefined> {
    const user = this.users.get(email.trim().toLowerCase());
    const target = user ?? this.dummy!;
    const candidate = await hash(password, target.salt);
    return user && timingSafeEqual(candidate, target.hash) ? user.principal : undefined;
  }
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
