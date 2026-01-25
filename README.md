# EcoFlow Grid Assist (ioBroker)

A robust ioBroker JavaScript solution that dynamically balances EcoFlow battery output
to minimize grid import while keeping the EcoFlow app’s **Home / Grid** display accurate —
even when the battery is empty or held at reserve SoC.

---

## Background / Why this exists

When my Shelly 3EM Pro stopped working — and I also noticed noticeable deviations compared
to my official smart meter — I switched to using a smart meter **IR reading head**
together with EcoFlow’s API integration.

I currently feed smart-meter-based consumption values into EcoFlow by updating:

- `dayResidentLoadList.loadPower1`

This was initially meant as a temporary workaround, but it turned out to work surprisingly well.  
In fact, the resulting system behavior — especially around low or near-zero consumption handling —
is much closer to my expectations than the original Shelly-based integration.

Example IR readers that work well in this setup:
- Hichi IR reader (https://sites.google.com/view/hichi-lesekopf/startseite)


If you're buying an EcoFlow system anyway, you can use my referral link:

👉 https://www.ecoflow.com/eu/referral-rewards?inviteCode=AHWULITSY1
---

## Introduction

Many EcoFlow users integrate their systems into ioBroker and combine them with
external smart meters (IR readers, Shelly 3EM, etc.).

While EcoFlow offers internal energy management, advanced users often want:

- More accurate grid-based control (smart meter as single source of truth)
- Stable “near-zero import” behavior
- Reliable Home / Grid values in the EcoFlow app
- A system that runs 24/7 without manual restarts

This project provides exactly that.

---

## The Challenge

When you feed an external smart meter directly into EcoFlow, you quickly run into
a few **very typical control challenges** — this is **not an EcoFlow bug**, but a
well-known feedback problem.

### The classic zig-zag problem

A simple example:

1. The smart meter reports **0 W grid import**
2. This value is sent to EcoFlow
3. EcoFlow assumes *no consumption* and reduces output
4. Actual house consumption immediately rises
5. The meter reports higher grid import again
6. EcoFlow reacts — and the cycle repeats

The result is a **zig-zag / oscillation** instead of a stable near-zero grid import.

This happens whenever:
- the same signal is used for **control** *and* **display**
- without considering delays, limits, and battery state

---

### Additional real-world challenges

In practice, several other effects add complexity:

- **Battery reserve (SoC):**  
  When the battery reaches its reserve, EcoFlow is no longer allowed to discharge —
  but naive controllers keep “pushing” anyway.

- **No actuator authority:**  
  If EcoFlow cannot discharge (empty battery, reserve reached),
  there is nothing left to control — but many scripts still try.

- **Display vs control confusion:**  
  Sometimes you want to *control* battery output,  
  sometimes you only want EcoFlow to *display* the correct household consumption.

- **Meter update gaps:**  
  IR readers and MQTT-based meters can miss updates temporarily,
  which can freeze values if not handled carefully.

- **Mode transitions:**  
  Switching between battery operation and grid-only operation
  often causes EcoFlow UI values to stall unless refreshed explicitly.

---

### The key insight

All of these issues have the same root cause:

> **Control logic and display logic are mixed.**

This script solves the problem by **clearly separating the two**:
- regulating only when regulation is possible
- and otherwise providing a clean, stable display feed

This is standard control-system practice — applied pragmatically to EcoFlow.


---

## The Solution

This script cleanly separates **two responsibilities**:

### 1) Control Mode (battery discharge allowed)

When SoC is above the configured reserve:

- Uses an integral controller to keep grid import near a small target
  (e.g. `20 W`)
- Adjusts the EcoFlow output setpoint in the range `0…800 W`
- Includes:
  - SoC gate (backup reserve protection)
  - output authority detection
  - anti-windup protection

### 2) Fallback Mode (battery discharge blocked)

When SoC is at or below the configured reserve:

- Stops all discharge control
- **Continuously forwards the raw grid import**
  to keep EcoFlow Home / Grid display correct and updating

No fake values.  
No frozen graphs.  
No manual restarts required.

---

## Key Features

- ✅ External smart meter as single source of truth
- ✅ Stable 24/7 operation (tested in real setup)
- ✅ Battery reserve aware (SoC gate)
- ✅ Accurate EcoFlow app Home / Grid display updates
- ✅ Minimal write rate (safe for MQTT / cloud APIs)
- ✅ No custom adapter required
- ✅ Works with EcoFlow Stream / Ultra systems
- ✅ Debug states created in `0_userdata.0.ecoflow.ctrl.*`

---


## How It Works (High Level)

    Smart Meter (IR reader)
      |
      v
    ioBroker JavaScript controller
      |
      +-- Control Mode (battery allowed)
      |     -> regulate EcoFlow output to reduce grid import
      |
      +-- Fallback Mode (battery blocked at reserve)
            -> forward raw grid import as display feed

    Breaking the loop (Control vs Display separation)

    +------------------------+
    | Smart meter (IR)       |
    +-----------+------------+
                |
                v
         Grid power reading
                |
          +-----+-----+
          |           |
          v           v

    +------------------------+    +------------------------+
    | CONTROL MODE           |    | FALLBACK MODE          |
    | (battery allowed)      |    | (reserve/empty)        |
    +-----------+------------+    +-----------+------------+
                |                         |
                v                         v
     regulate EcoFlow output        display feed only
                |                         |
                v                         v
     EcoFlow output setpoint (u)    forward raw grid import
                |                         |
                v                         v
     grid import -> near zero        EcoFlow Home/Grid correct

    Key idea: Only regulate when regulation is possible. Otherwise, just report the truth.
