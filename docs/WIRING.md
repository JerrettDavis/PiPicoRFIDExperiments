# Wiring: RP2040 / Pico to RC522

Use 3.3V only. Do not power the RC522 from VBUS/5V.

| RC522 pin | RP2040 / Pico GPIO | Pico physical pin | Purpose |
|---|---:|---:|---|
| 3.3V | 3V3 OUT | 36 | Power |
| GND | GND | any GND | Ground |
| SDA / SS / NSS | GP17 | 22 | SPI chip select |
| SCK | GP18 | 24 | SPI clock |
| MOSI | GP19 | 25 | SPI MOSI |
| MISO | GP16 | 21 | SPI MISO |
| RST | GP20 | 26 | Reset |
| IRQ | GP21 | 27 | Optional interrupt wire, wired for later |

Schematic-style:

```text
Pico / RP2040                         RC522
────────────────                      ─────────────
3V3 OUT      ───────────────────────>  3.3V
GND          ───────────────────────>  GND
GP17         ───────────────────────>  SDA / SS / NSS
GP18         ───────────────────────>  SCK
GP19         ───────────────────────>  MOSI
GP16         <───────────────────────  MISO
GP20         ───────────────────────>  RST
GP21         <───────────────────────  IRQ
```
