import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { WalletProvider } from './wallet';
import { KeysProvider } from './launch/keys';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <WalletProvider>
      <KeysProvider>
        <App />
      </KeysProvider>
    </WalletProvider>
  </StrictMode>,
);
