<?php
declare(strict_types=1);

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  JOSEPAN 360 · OMNI · SDK CLIENTE PHP
 *  api/OmniCoreClient.php — Cliente cURL hacia el OMNI API CORE v6 [1001]
 *
 *  ┌─────────────────────────────────────────────────────────────────────┐
 *  │  IMPORTANTE                                                           │
 *  │  Este archivo replica el CONTRATO del SDK oficial que ya usas en      │
 *  │  [1002] y [1004]. Si tienes tu OmniCoreClient.php canónico, SUSTITUYE │
 *  │  este archivo por el tuyo: la app solo depende de la interfaz pública │
 *  │  documentada abajo (login / setToken / setInterlocutor / request /    │
 *  │  endpoint / me).                                                      │
 *  └─────────────────────────────────────────────────────────────────────┘
 *
 *  Toda respuesta tiene la forma:
 *    ['ok'=>bool, 'status'=>int, 'data'=>mixed, 'error'=>?string]
 * ═══════════════════════════════════════════════════════════════════════════
 */
final class OmniCoreClient
{
    private string $host;
    private string $prefix;
    private ?string $token = null;
    private $interlocutorId = null;

    public function __construct(string $host, string $prefix = '/api/v1')
    {
        $this->host   = rtrim($host, '/');
        $this->prefix = '/' . trim($prefix, '/');
    }

    public function setToken(string $jwt): void
    {
        $this->token = $jwt;
    }

    public function setInterlocutor($id): void
    {
        $this->interlocutorId = $id;
    }

    /** Construye la URL absoluta: host + prefix + path */
    public function endpoint(string $path): string
    {
        return $this->host . $this->prefix . '/' . ltrim($path, '/');
    }

    /**
     * Autenticación. El API CORE v6 espera username + password + interlocutor_id
     * (ver colección Postman). Se envían alias de usuario por compatibilidad.
     */
    public function login(array $credentials): array
    {
        $user = $credentials['usuario']
            ?? $credentials['username']
            ?? $credentials['email']
            ?? '';

        $body = json_encode([
            'username'        => $user,
            'usuario'         => $user,
            'email'           => $user,
            'password'        => $credentials['password'] ?? '',
            'interlocutor_id' => $credentials['interlocutor_id'] ?? 1,
        ], JSON_UNESCAPED_UNICODE);

        $res = $this->request('POST', '/auth/login', $body, false);

        if ($res['ok']) {
            $token = $res['data']['token']
                ?? $res['data']['access_token']
                ?? null;
            if (is_string($token)) {
                $this->setToken($token);
            }
        }
        return $res;
    }

    /** Perfil del usuario autenticado (claims + permisos). */
    public function me(): array
    {
        return $this->request('GET', '/auth/me', null, true);
    }

    /**
     * Petición genérica vía cURL.
     * @param bool $auth Si true, inyecta Authorization + X-Interlocutor-Id.
     */
    public function request(string $method, string $path, ?string $jsonBody = null, bool $auth = true): array
    {
        $url = $this->endpoint($path);
        $ch  = curl_init($url);

        $headers = ['Accept: application/json'];
        if ($jsonBody !== null) {
            $headers[] = 'Content-Type: application/json';
        }
        if ($auth) {
            if ($this->token !== null) {
                $headers[] = 'Authorization: Bearer ' . $this->token;
            }
            if ($this->interlocutorId !== null) {
                $headers[] = 'X-Interlocutor-Id: ' . $this->interlocutorId;
            }
        }

        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CUSTOMREQUEST  => strtoupper($method),
            CURLOPT_HTTPHEADER     => $headers,
            CURLOPT_TIMEOUT        => 30,
            CURLOPT_CONNECTTIMEOUT => 10,
        ]);
        if ($jsonBody !== null) {
            curl_setopt($ch, CURLOPT_POSTFIELDS, $jsonBody);
        }

        $raw    = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $cerr   = curl_error($ch);
        curl_close($ch);

        if ($raw === false) {
            return ['ok' => false, 'status' => 0, 'data' => null, 'error' => 'ERR_NETWORK: ' . $cerr];
        }

        $data = json_decode($raw, true);
        $httpOk = $status >= 200 && $status < 300;

        // Sobre canónico OMNI API CORE v6.6.0: { status, data, message, error_code }
        if (is_array($data) && isset($data['status']) && in_array($data['status'], ['success', 'error'], true)) {
            $ok = $data['status'] === 'success';
            return [
                'ok'     => $ok,
                'status' => $status,
                'data'   => $data['data'] ?? null,                     // payload interno desenvuelto
                'error'  => $ok ? null : ($data['message'] ?? 'ERR_API'),
                'code'   => $ok ? null : ($data['error_code'] ?? null),
            ];
        }

        // Fallback para respuestas sin sobre (errores de gateway, etc.)
        return [
            'ok'     => $httpOk,
            'status' => $status,
            'data'   => $data,
            'error'  => $httpOk ? null : ($data['message'] ?? $data['error'] ?? ('HTTP_' . $status)),
        ];
    }
}
