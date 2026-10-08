import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { Confidence, PublicCase, Source } from '@sia/case-schema';
import { CONFIDENCE_HINT, CONFIDENCE_LABEL, formatDate } from '@sia/dive-engine';
import { sourceLinkId, testIds } from './testIds';
import { colors, space, type } from './theme';

export const SOURCE_TYPE_LABEL: Record<Source['type'], string> = {
  court_record: 'Court record',
  official: 'Official',
  primary: 'Primary document',
  news: 'News',
  analysis: 'Analysis',
};

export function ConfidenceLabel({ confidence, showHint = false }: { confidence: Confidence; showHint?: boolean }) {
  return (
    <View style={styles.confidence} testID={testIds.confidence}>
      <Text style={[type.caps, styles.confidenceLabel]} accessibilityHint={CONFIDENCE_HINT[confidence]}>
        {CONFIDENCE_LABEL[confidence]}
      </Text>
      {showHint ? <Text style={type.small}>{CONFIDENCE_HINT[confidence]}</Text> : null}
    </View>
  );
}

export function sourcesById(doc: Pick<PublicCase, 'sources'>, ids: readonly string[]): Source[] {
  return ids.map((id) => doc.sources.find((s) => s.id === id)).filter((s): s is Source => s !== undefined);
}

/** A compact citation line: each source as a link that opens its URL. */
export function Citations({
  doc,
  ids,
  openUrl,
}: {
  doc: Pick<PublicCase, 'sources'>;
  ids: readonly string[];
  openUrl: (url: string) => void;
}) {
  const sources = sourcesById(doc, ids);
  if (sources.length === 0) return null;
  return (
    <View style={styles.citations}>
      <Text style={type.small}>{sources.length === 1 ? 'Source' : 'Sources'}</Text>
      {sources.map((s) => (
        <Pressable
          key={s.id}
          onPress={() => openUrl(s.url)}
          accessibilityRole="link"
          accessibilityLabel={`${s.publisher}: ${s.title}`}
          testID={sourceLinkId(s.id)}
          hitSlop={4}
        >
          <Text style={[type.small, styles.citation]}>
            {s.publisher}, <Text style={styles.citationTitle}>{s.title}</Text> ({formatDate(s.date)})
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  confidence: { gap: space.xs },
  confidenceLabel: { color: colors.ink },
  citations: { gap: 2 },
  citation: { color: colors.muted, textDecorationLine: 'underline', textDecorationColor: colors.rule },
  citationTitle: { fontStyle: 'italic' },
});
