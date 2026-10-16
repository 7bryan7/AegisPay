type WalletAccountListener = (accountId: string | null) => void;

let currentAccountId: string | null = null;
const listeners = new Set<WalletAccountListener>();

export function getWalletAccountId(): string | null {
  return currentAccountId;
}

export function setWalletAccountId(accountId: string | null): void {
  currentAccountId = accountId;
  for (const listener of listeners) listener(accountId);
}

export function subscribeWalletAccount(listener: WalletAccountListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}