/**
 * SQL query constants for the telemetry_public tool (E0008)
 *
 * These query the oddkit_telemetry Analytics Engine dataset.
 * All queries use SUM(_sample_interval) to account for Analytics Engine
 * sampling at high volumes.
 *
 * See: klappy://canon/constraints/telemetry-governance
 */

export const TELEMETRY_QUERIES = {
  summary_30d: `
    SELECT
      COUNT(*) as total_events,
      SUM(CASE WHEN blob1 = 'tool_call' THEN _sample_interval ELSE 0 END) as tool_calls,
      SUM(_sample_interval) as total_requests
    FROM oddkit_telemetry
    WHERE timestamp > NOW() - INTERVAL '30' DAY
  `,

  tools: `
    SELECT blob3 AS tool, SUM(_sample_interval) AS calls
    FROM oddkit_telemetry
    WHERE blob1 = 'tool_call'
    GROUP BY tool
    ORDER BY calls DESC
    LIMIT 20
  `,

  consumers: `
    SELECT blob4 AS consumer, blob5 AS source, SUM(_sample_interval) AS calls
    FROM oddkit_telemetry
    WHERE blob1 = 'tool_call'
    GROUP BY consumer, source
    ORDER BY calls DESC
    LIMIT 20
  `,

  canon_urls: `
    SELECT blob6 AS canon_url, SUM(_sample_interval) AS calls
    FROM oddkit_telemetry
    GROUP BY canon_url
    ORDER BY calls DESC
    LIMIT 20
  `,

  documents: `
    SELECT blob7 AS document_uri, SUM(_sample_interval) AS calls
    FROM oddkit_telemetry
    WHERE blob7 != ''
    GROUP BY document_uri
    ORDER BY calls DESC
    LIMIT 20
  `,

  daily_trend: `
    SELECT
      toStartOfDay(timestamp) AS day,
      SUM(_sample_interval) AS calls
    FROM oddkit_telemetry
    GROUP BY day
    ORDER BY day DESC
    LIMIT 30
  `,

  methods: `
    SELECT blob2 AS method, SUM(_sample_interval) AS calls
    FROM oddkit_telemetry
    GROUP BY method
    ORDER BY calls DESC
  `,
} as const;
