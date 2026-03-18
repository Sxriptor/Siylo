# Remote Access

Do not expose `3210` or `3443` directly to the Internet.

Supported model:

1. Enable remote access in the desktop dashboard.
2. Keep the local origin bound to `http://localhost:3443`.
3. Put a named Cloudflare Tunnel in front of it.
4. Put Cloudflare Access in front of the public hostname.

Local origin:

```text
http://localhost:3443/radio
```

Recommended Cloudflare flow:

1. Install `cloudflared` using Cloudflare's official install instructions.
2. Authenticate:

```powershell
cloudflared tunnel login
```

3. Create a named tunnel:

```powershell
cloudflared tunnel create siylo-radio
```

4. Route a DNS hostname you control:

```powershell
cloudflared tunnel route dns siylo-radio radio.example.com
```

5. Create a config file similar to:

```yaml
tunnel: siylo-radio
credentials-file: C:\Users\<you>\.cloudflared\<tunnel-id>.json

ingress:
  - hostname: radio.example.com
    service: http://localhost:3443
  - service: http_status:404
```

6. Run the tunnel:

```powershell
cloudflared tunnel run siylo-radio
```

7. In Cloudflare Zero Trust, create an Access policy for `radio.example.com`.

Recommended Access gate:

- Require an identity provider or one-time email code.
- Keep Siylo's own username/password enabled as a second layer.

Notes:

- The local origin is loopback-only by design.
- `cloudflared` should be the only process reaching it from outside the browser.
- `trycloudflare.com` is fine for temporary testing, but the supported path here is a named tunnel.
