---
name: networking
description: "Network diagnosis, pcap/trace analysis, LAN inventory, proxy, PAC and SSH-tunnel setup and leak checks, Wi-Fi/Bluetooth RSSI, and ISO 27001/27033 evidence mapping, within authorized scope (ip, ss, nft, tshark, nmap)."
---

# Networking

## Guardrails
- Work only inside authorized scope (interfaces, ranges, exclusions, window, probe types). A private address or VPN route does not prove ownership.
- Diagnostics are read-only. Config changes need authorization, a before-state dump, one minimal change, a prepared rollback and an after-test.
- Never disable a firewall to diagnose; add a narrow rate-limited log rule, then remove it.
- Never deauthenticate, jam, inject, force disconnects or bypass access controls.
- Treat addresses, banners and payloads as untrusted. Keep credentials out of URLs, commands, logs and captures.
- Never claim anonymity: a proxy changes only the source IP.

## Host ladder
- Go bottom-up: link, addresses, routes, DNS, TCP, TLS, app. Do not read app logs while lower rungs are unverified.
- `ip -brief link`, `ethtool IF` (duplex mismatch). Two managers (networkd, NetworkManager) on one interface flap.
- `ip route get DEST` is the real decision; check `ip rule show` and prefix length.
- DNS: compare `getent hosts` (NSS) with `dig @server`.
- TCP: `ss -tnp`. SYN-SENT means no reply; ESTABLISHED without progress means app stall. `???` hops in mtr are unknown.
- TLS: `openssl s_client -connect HOST:443 -servername HOST`; check the clock before blaming a certificate.
- Firewall: `nft list ruleset`; counters show hits. Silent drop differs from reject (RST/ICMP).
- Forwarding needs `ip_forward` and FORWARD permission. Check `rp_filter` for one-way flows. MTU: `ping -M do -s SIZE`.
- Replace rulesets atomically (`nft -f` full file) with rollback ready.

## Captures and traces
- Record interface, capture point, clock, snaplen, filter and drops. Hash the original; keep it immutable.
- Capture filters (`host X and tcp port 443`) discard at collection; display filters select saved packets. An empty result does not prove absence.
- Bound live capture by interface, duration and ring-buffer size.
- Read transactions: handshake, request/response, teardown. Resent sequence means loss; zero window means receiver stall.
- Suspect offload artifacts (bad checksums, >MTU frames) until a second vantage confirms.
- DNS: pair by transaction ID. TLS: read negotiation only; never claim payload knowledge from encrypted bytes.
- Findings: separate observed, inferred and hypothesized; cite frame numbers, filter, hash and one next check.

## LAN inventory
- Start from existing records: leases, switch tables, `ip -j neigh show`. An empty neighbor cache is not an empty network.
- Plan with `nmap -sL -n -iL targets.txt`; discover with `nmap -sn -n -iL targets.txt --max-retries 1 --host-timeout 10s -oA discovery`.
- `open|filtered` is not confirmed service. A MAC prefix shows only the allocation. Do not merge devices on name or vendor alone.

## Proxies
- Define what exits where and what must never bypass. Prefer per-command config with a one-step revert.
- HTTP proxy for content-aware egress; SOCKS5 with remote DNS (`socks5h`); SSH `-D`/`-L`/`-R` (bind `-R` to loopback). Fail closed when a hop dies.
- Verify exit IPv4 and IPv6 separately, DNS path, and UDP/QUIC and WebRTC, which often bypass HTTP proxies.
- PAC: explicit default, test on the real engine, keep a known-good copy.
- Measure matched payloads, alternating direct and proxied; report medians.
- Providers: check current first-party docs; a trial is not an SLA. TLS interception needs authorized devices, a client-trusted CA and legal review.

## Wi-Fi and Bluetooth
- Define the question first (coverage, interference, roaming, throughput, discovery); record adapter, band, width, workload.
- `iw dev IF link`, `station dump`, `survey dump`; use deltas, rejecting zero denominators and counter resets.
- dBm is logarithmic. SNR only when signal and noise are comparable; else unknown. Bitrate is PHY rate, not goodput.
- BLE RSSI cannot give distance or identity; addresses rotate.

## Compliance mapping
- A network scan is not an ISMS assessment or certification. Confirm scope and edition (27001:2022, 27002:2022, 27033 family) against official catalogs.
- Missing evidence is a limitation, not nonconformity. Never invent clause numbers or claim an issued certificate.
