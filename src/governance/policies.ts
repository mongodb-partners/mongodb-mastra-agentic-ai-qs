import { z } from 'zod';

export const POLICIES_COLLECTION = 'policies';
export const POLICY_VECTOR_INDEX = 'policy_vector_index';
export const POLICY_SEARCH_INDEX = 'policy_search_index';

export const SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export type Severity = (typeof SEVERITIES)[number];

/** Deterministic severity penalties subtracted from a compliance score of 1.0. */
export const SEVERITY_PENALTY: Record<Severity, number> = {
  low: 0.05, medium: 0.15, high: 0.25, critical: 0.4,
};

/** Below this compliance score, an action is HELD and routed to human review. */
export const COMPLIANCE_THRESHOLD = 0.7;

export const PolicySchema = z.object({
  policy_code: z.string().regex(/^[A-Z]{2,6}-[A-Z0-9]+-\d{3}$/),
  policy_text: z.string().min(1),
  category: z.enum(['aml', 'sanctions', 'fraud', 'kyc', 'privacy']),
  source: z.string().min(1),               // regulation citation
  severity: z.enum(SEVERITIES),
  rule_version: z.number().int().positive(),
  is_current_version: z.boolean(),
  embedding: z.array(z.number()).length(1024),
});
export type Policy = z.infer<typeof PolicySchema>;

/** Seed policy set (embeddings attached at seed time). policy_text is written for retrieval. */
export const POLICY_SEED: Omit<Policy, 'embedding'>[] = [
  {
    policy_code: 'AML-STRUCT-001',
    policy_text: 'A cash deposit or transfer just under the 5000 USD currency-transaction reporting threshold, especially in a repeated sub-threshold pattern, is structuring and must be escalated for SIU review rather than auto-approved.',
    category: 'aml', source: '31 U.S.C. § 5324; 31 CFR 1010.314',
    severity: 'high', rule_version: 1, is_current_version: true,
  },
  {
    policy_code: 'SANC-SCREEN-001',
    policy_text: 'A transaction whose counterparty matches a sanctions or watchlist screening hit must be blocked and reported; it may not be approved under any circumstances.',
    category: 'sanctions', source: 'OFAC 31 CFR Part 501',
    severity: 'critical', rule_version: 1, is_current_version: true,
  },
  {
    policy_code: 'AML-RING-001',
    policy_text: 'A transaction originating from an account that is part of a circular money-flow network (mule ring / layering) must be escalated for investigation and may not be auto-approved.',
    category: 'aml', source: 'FinCEN layering guidance',
    severity: 'high', rule_version: 1, is_current_version: true,
  },
  {
    policy_code: 'FRAUD-HIGHVAL-001',
    policy_text: 'A high-value transaction at or above 50000 USD that would otherwise be approved must be escalated for a second-line review before funds are released.',
    category: 'fraud', source: 'Internal high-value control',
    severity: 'medium', rule_version: 1, is_current_version: true,
  },
  {
    policy_code: 'FRAUD-ATO-001',
    policy_text: 'A card-not-present charge to an unrecognized merchant immediately following an unusual or foreign login is consistent with account takeover and must be rejected.',
    category: 'fraud', source: 'Internal ATO control',
    severity: 'high', rule_version: 1, is_current_version: true,
  },
];
