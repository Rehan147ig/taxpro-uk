import React from 'react';
import type { AiAgentRun } from '../api/client';

interface Props {
  findings: { pending: boolean; agents: AiAgentRun[] } | null;
}

function findAgent(agents: AiAgentRun[], name: string) {
  return agents.find(a => a.workflowName === name);
}

const fmtGbp = (n: number) => `£${Math.round(n).toLocaleString()}`;

export default function AiFindingsPanel({ findings }: Props) {
  if (!findings) return null;

  if (findings.pending && findings.agents.length === 0) {
    return (
      <div className="bg-white rounded-xl border border-gray-200 p-4">
        <h3 className="font-semibold mb-1">AI Findings</h3>
        <p className="text-sm text-gray-500">Subagents still running — this updates automatically.</p>
      </div>
    );
  }

  const mapping = findAgent(findings.agents, 'subagent_mapping_agent')?.output;
  const audit = findAgent(findings.agents, 'subagent_audit_defense')?.output;
  const credits = findAgent(findings.agents, 'subagent_credit_miner')?.output;

  return (
    <div className="space-y-4">
      <h3 className="font-semibold">AI Findings</h3>

      {audit && (
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <div className="flex justify-between items-center mb-2">
            <h4 className="font-medium text-sm">Audit Defense Memo</h4>
            {typeof audit.qualityScore === 'number' && (
              <span className={`px-2 py-0.5 rounded-full text-xs ${
                audit.qualityScore >= 80 ? 'bg-green-100 text-green-700' :
                audit.qualityScore >= 60 ? 'bg-yellow-100 text-yellow-700' :
                'bg-red-100 text-red-700'
              }`}>
                quality {audit.qualityScore}/100
              </span>
            )}
          </div>
          {audit.executiveSummary && (
            <p className="text-sm text-gray-700 whitespace-pre-wrap">{audit.executiveSummary}</p>
          )}

          {audit.technicalMemos?.length > 0 && (
            <div className="mt-3 space-y-2">
              <p className="text-xs font-medium text-gray-500 uppercase">Technical Memos ({audit.technicalMemos.length})</p>
              {audit.technicalMemos.map((m: any, i: number) => (
                <div key={i} className="border border-gray-100 rounded-lg p-3">
                  <div className="flex justify-between items-start">
                    <p className="text-sm font-medium">{m.title}</p>
                    <span className={`px-1.5 py-0.5 rounded text-xs ${
                      m.riskLevel === 'high' ? 'bg-red-100 text-red-700' :
                      m.riskLevel === 'medium' ? 'bg-yellow-100 text-yellow-700' :
                      'bg-green-100 text-green-700'
                    }`}>{m.riskLevel} risk</span>
                  </div>
                  <p className="text-xs text-brand-600 mt-0.5">{m.ircSection} · {m.citation}</p>
                  <p className="text-xs text-gray-600 mt-1">{m.narrative}</p>
                  {typeof m.taxImpact === 'number' && (
                    <p className="text-xs text-gray-500 mt-1">Tax impact: {fmtGbp(m.taxImpact)}</p>
                  )}
                </div>
              ))}
            </div>
          )}

          {audit.riskFlags?.length > 0 && (
            <div className="mt-3">
              <p className="text-xs font-medium text-gray-500 uppercase mb-1">Risk Flags</p>
              {audit.riskFlags.map((f: any, i: number) => (
                <div key={i} className={`text-xs rounded-lg p-2 mt-1 ${
                  f.severity === 'high' ? 'bg-red-50 text-red-700' :
                  f.severity === 'medium' ? 'bg-yellow-50 text-yellow-700' :
                  'bg-blue-50 text-blue-700'
                }`}>
                  <span className="font-medium">[{f.severity}]</span> {f.description}
                  {f.recommendation && <span className="block mt-0.5 opacity-80">{f.recommendation}</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {credits?.summary && (
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <div className="flex justify-between items-center mb-2">
            <h4 className="font-medium text-sm">Credit Opportunities</h4>
            {credits.summary.totalIdentifiedCredits > 0 && (
              <span className="px-2 py-0.5 rounded-full text-xs bg-green-100 text-green-700">
                ~{fmtGbp(credits.summary.totalIdentifiedCredits)} identified
              </span>
            )}
          </div>

          {credits.rdCredit && (
            <div className="border border-gray-100 rounded-lg p-3 mb-2">
              <p className="text-sm font-medium">R&D relief — requires UK review (US Sec 41 output)</p>
              <p className="text-xs text-gray-600 mt-1">
                QRE: {fmtGbp(credits.rdCredit.qualifiedResearchExpenses)} → estimated credit {fmtGbp(credits.rdCredit.computedCredit)} ({credits.rdCredit.method.replace(/_/g, ' ')})
              </p>
              {credits.rdCredit.accountsIdentified?.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {credits.rdCredit.accountsIdentified.map((a: any, i: number) => (
                    <span key={i} className="px-1.5 py-0.5 rounded text-xs bg-gray-100 text-gray-600">
                      {a.name} ({fmtGbp(a.amount)})
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}

          {credits.section174 && (
            <div className="border border-gray-100 rounded-lg p-3 mb-2">
              <p className="text-sm font-medium">R&D capitalisation — requires UK review (US Sec 174 output)</p>
              <p className="text-xs text-gray-600 mt-1">
                {fmtGbp(credits.section174.totalQualifiedExpenses)} over {credits.section174.domesticAmortizationPeriod}yr → {fmtGbp(credits.section174.domesticAmortizationCurrent)}/yr amortization (DTA)
              </p>
            </div>
          )}

          {credits.energyCredits?.map((e: any, i: number) => (
            <div key={i} className="border border-gray-100 rounded-lg p-3 mb-2">
              <p className="text-sm font-medium">{e.ircSection} — {e.type.replace(/_/g, ' ')}</p>
              <p className="text-xs text-gray-600 mt-1">{e.description}: ~{fmtGbp(e.estimatedCredit)}</p>
            </div>
          ))}

          {credits.summary.recommendations?.length > 0 && (
            <ul className="mt-2 space-y-1">
              {credits.summary.recommendations.map((r: string, i: number) => (
                <li key={i} className="text-xs text-gray-600">• {r}</li>
              ))}
            </ul>
          )}

          {!credits.rdCredit && !credits.section174 && credits.energyCredits?.length === 0 && (
            <p className="text-sm text-gray-500">No credit opportunities identified in this trial balance.</p>
          )}
        </div>
      )}

      {mapping && (
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <h4 className="font-medium text-sm mb-2">Classification Detail</h4>
          {mapping.taxMappings?.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="text-left px-2 py-1.5 font-medium text-gray-500">Tax Category</th>
                    <th className="text-left px-2 py-1.5 font-medium text-gray-500">Treatment</th>
                    <th className="text-left px-2 py-1.5 font-medium text-gray-500">Section</th>
                    <th className="text-left px-2 py-1.5 font-medium text-gray-500">Conf.</th>
                  </tr>
                </thead>
                <tbody>
                  {mapping.taxMappings.map((m: any, i: number) => (
                    <tr key={i} className="border-b border-gray-100" title={m.explanation}>
                      <td className="px-2 py-1.5">{m.taxAccountType}</td>
                      <td className="px-2 py-1.5">
                        <span className={`px-1.5 py-0.5 rounded ${
                          m.bookTreatment === 'permanent' ? 'bg-purple-100 text-purple-700' :
                          m.bookTreatment === 'temporary' ? 'bg-blue-100 text-blue-700' :
                          'bg-gray-100 text-gray-600'
                        }`}>{m.bookTreatment}</span>
                      </td>
                      <td className="px-2 py-1.5 text-brand-600">{m.ircSection}</td>
                      <td className={`px-2 py-1.5 ${m.confidenceScore >= 0.75 ? 'text-green-600' : 'text-yellow-600'}`}>
                        {Math.round((m.confidenceScore ?? 0) * 100)}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-gray-500">No mapping detail available.</p>
          )}
        </div>
      )}

      {!mapping && !audit && !credits && (
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <p className="text-sm text-gray-500">No AI findings recorded for this run.</p>
        </div>
      )}
    </div>
  );
}

