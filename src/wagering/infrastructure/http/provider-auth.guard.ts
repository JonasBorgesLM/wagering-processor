import { type CanActivate, Injectable } from "@nestjs/common";

/**
 * The place authentication goes, and nothing more (ADR-0009). It lets every request through.
 *
 * The intended design is a client-credentials token per provider, validated here against the identity
 * provider's keys, with the token's provider claim compared with the `providerId` in the payload. It is
 * attached to every business controller, and a test fails if a controller is added without it, so adding the
 * real check later touches this class and nothing else.
 *
 * Until then anyone who can reach the API can act as any provider (SR-03).
 */
@Injectable()
export class ProviderAuthGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}
