import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import WaterApp from './WaterApp.tsx';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <WaterApp />
  </StrictMode>,
);
