# Local system and endpoint diagnosis

Use the existing `sys_probe` and `net_probe` owners to collect several related
facts in one call. Their results separate observations, missing evidence and
proposed next checks. Safe read-only checks run autonomously. These tools never
apply a recovery plan, change configuration, signal a process or restart a
service.

```json
{"action":"diagnose","pid":42,"port":8080,"unit":"example.service"}
```

The example is for `sys_probe`. Omit targets that are irrelevant: resource
metadata is always collected; a process, TCP listener or systemd unit is inspected
only when explicitly supplied. Unit inspection reuses `service_detail`; set
`user:true` with an explicit unit to inspect the current user manager. The tool
collects available memory, load, CPU/memory/I/O pressure and current unified
cgroup quotas. It reads a PID's numeric status, checks one port with fixed `ss`
arguments and returns allowlisted unit state. No process argv/environment,
hostname, interface addresses, service commands or journal message bodies leave
the tool. No service or process enumeration happens by default.

Each phase preserves `permission_denied`, `unavailable`, `manager_unavailable`,
`limit`, `cancelled`, `invalid_metadata` or generic failure when observed.
Missing listener ownership is unknown; it does not prove insufficient permission.
Missing cgroup paths, unsupported v1 and missing pressure data stay partial.
Load is runnable plus uninterruptible work; it is not CPU utilization. Kernel
resources and listeners describe the current process namespace, which may differ
from the physical host. PID reuse and actual service identity remain separate
checks. A 4.5-second budget bounds parallel phases. The port command has a fixed
system path, clean environment, two-second deadline and 64 KiB output cap; unit
inspection retains the existing bounded service adapter and shares the overall
deadline. Individual fixed metadata reads cap at 16 KiB.

```json
{"action":"diagnose","host":"127.0.0.1","port":8080,"protocol":"http","path":"/ready"}
```

The example is for `net_probe`. Protocol defaults to `tcp`; `tls`, `http` and
`https` add only the requested layers. The system resolver selects one address,
and one socket supplies TCP, TLS and fixed HTTP `HEAD` evidence. HTTP/HTTPS
require an explicit public pathname without query, fragment, encoded characters
or credentials. There are no custom headers, request bodies, proxies, cookies,
redirects, retries or alternate-address attempts. HTTPS validates the chain and
hostname using built-in Node roots and sends no application bytes when trust
fails. Private addresses and loopback can be diagnosed when explicitly requested;
unspecified, link-local/metadata, multicast and broadcast connection targets are
blocked before traffic, including a blocked address returned by DNS.

The ordered `phases` preserve lower-layer successes when an upper layer fails.
DNS failure sends no connection. TCP refusal does not prove a firewall fault.
HTTP status separates redirects, authorization, missing routes, unsupported HEAD,
rate limits and server failure, while omitting header values and bodies. A 2xx
response establishes only this HEAD readiness check. Full application behavior,
other addresses, routing policy and authentication remain untested. Results are
live, never cached, with a single 4.5-second budget and bounded partial evidence.

The loopback fixture verifies one native MCP invocation produces three ordered
DNS/TCP/HTTP phases using exactly one connection and one request. The Linux
fixture verifies resource, exact PID and exact port evidence in one native
invocation. This reduces separate inspection calls; it is not a benchmark claim
about production latency or token savings. Additional fixtures cover TLS trust
failure without HTTP, refusal, status classification, cancellation, deadlines,
oversize headers, metadata-address rejection and omission of secret canaries.
Trusted remote HTTPS and production service recovery were not exercised.

Run `node --test tests/system-network-diagnosis.test.mjs` in the public tree.
The implementation uses Node's [TLS identity and trust APIs](https://nodejs.org/api/tls.html)
and [system DNS lookup](https://nodejs.org/api/dns.html); it adds no packages.
