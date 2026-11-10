# Water ADC WebApp

Focused Web Bluetooth monitor for the matching nRF54L15 / NCS 3.3.0 firmware.
It keeps the existing VNS WebApp visual system and responsive screen proportions while
reducing the product to the first bring-up path: `P1.06 / AIN2`, 100 Hz, realtime plot.

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies: `npm install`
2. Run the app: `npm run dev`
3. Open the localhost URL in Chrome or Edge, click **Connect**, and select **Water ADC**.

The browser device chooser is filtered by the Water firmware's advertised custom Service UUID,
so unrelated nearby Bluetooth devices are hidden without relying on name parsing.

The app uses the same custom Service/TX/RX Web Bluetooth structure as VNS. TX carries
20-byte notifications with seven 12-bit ADC samples and a 16-bit sequence number. The
monitor displays raw counts, nominal millivolts, and detected loss over a rolling 10-second
window.
