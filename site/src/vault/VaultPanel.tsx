import Vault from './Vault';

export function VaultPanel({ buy }: { buy?: string | null }) {
  return <Vault buy={buy} />;
}

export default VaultPanel;
