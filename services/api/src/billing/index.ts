/**
 * Billing provider abstraction. Business logic never calls Stripe directly — it
 * goes through this interface, so Stripe, another PSP, or manual enterprise
 * licensing are interchangeable. License/entitlement checks stay in the central
 * entitlement service; billing only feeds it.
 */
import type { Plan } from "@kinynx/shared";
import type { Config } from "../config.js";

export interface CheckoutResult {
  mode: "redirect" | "manual";
  url?: string;
  message?: string;
}

export interface BillingProvider {
  readonly name: string;
  createCheckout(input: { organizationId: string; plan: Plan; customerEmail?: string }): Promise<CheckoutResult>;
}

class ManualBilling implements BillingProvider {
  readonly name = "manual";
  async createCheckout(input: { plan: Plan }): Promise<CheckoutResult> {
    return {
      mode: "manual",
      message:
        input.plan === "enterprise"
          ? "Contact sales@kinynx.dev for an Enterprise license, then upload it in the admin console."
          : "This deployment uses manual billing. Contact your administrator to change plans.",
    };
  }
}

class StripeBilling implements BillingProvider {
  readonly name = "stripe";
  constructor(private readonly cfg: Config) {}
  async createCheckout(input: { organizationId: string; plan: Plan; customerEmail?: string }): Promise<CheckoutResult> {
    const price = input.plan === "team" ? this.cfg.STRIPE_PRICE_TEAM : this.cfg.STRIPE_PRICE_ENTERPRISE;
    if (!this.cfg.STRIPE_SECRET_KEY || !price) return { mode: "manual", message: "Stripe is not fully configured." };

    // Stripe Checkout Session via REST (form-encoded), no SDK dependency.
    const params = new URLSearchParams();
    params.set("mode", "subscription");
    params.set("line_items[0][price]", price);
    params.set("line_items[0][quantity]", "1");
    params.set("success_url", `${this.cfg.BILLING_SUCCESS_URL ?? this.cfg.PUBLIC_APP_URL}/billing/success`);
    params.set("cancel_url", `${this.cfg.BILLING_SUCCESS_URL ?? this.cfg.PUBLIC_APP_URL}/billing/cancel`);
    params.set("client_reference_id", input.organizationId);
    if (input.customerEmail) params.set("customer_email", input.customerEmail);

    const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: { authorization: `Bearer ${this.cfg.STRIPE_SECRET_KEY}`, "content-type": "application/x-www-form-urlencoded" },
      body: params,
    });
    if (!res.ok) throw new Error(`stripe error ${res.status}: ${await res.text().catch(() => "")}`);
    const body = (await res.json()) as { url?: string };
    return { mode: "redirect", url: body.url };
  }
}

export function createBillingProvider(cfg: Config): BillingProvider {
  return cfg.BILLING_PROVIDER === "stripe" ? new StripeBilling(cfg) : new ManualBilling();
}
