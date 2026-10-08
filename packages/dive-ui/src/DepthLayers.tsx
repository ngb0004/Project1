import { StyleSheet, Text, View } from 'react-native';
import type { Layer, PublicCase } from '@sia/case-schema';
import { formatDate } from '@sia/dive-engine';
import { Citations } from './Sources';
import { depthLayerId, testIds } from './testIds';
import { colors, fonts, space, type } from './theme';
import { Kicker, Title } from './ui';

const KIND_LABEL: Record<Layer['kind'], string> = {
  document: 'Document',
  quote: 'Quote',
  timeline: 'Timeline',
  context: 'Context',
};

/** The tap-to-go-deeper material behind a step, each layer with its cited sources. */
export function DepthLayers({
  doc,
  layers,
  openUrl,
}: {
  doc: Pick<PublicCase, 'sources'>;
  layers: readonly Layer[];
  openUrl: (url: string) => void;
}) {
  return (
    <View style={styles.list} testID={testIds.depth}>
      {layers.map((layer) => (
        <View key={layer.id} style={styles.layer} testID={depthLayerId(layer.id)}>
          <Kicker>{KIND_LABEL[layer.kind]}</Kicker>
          <LayerBody layer={layer} doc={doc} openUrl={openUrl} />
        </View>
      ))}
    </View>
  );
}

function LayerBody({
  layer,
  doc,
  openUrl,
}: {
  layer: Layer;
  doc: Pick<PublicCase, 'sources'>;
  openUrl: (url: string) => void;
}) {
  switch (layer.kind) {
    case 'document':
      return (
        <>
          <Title>{layer.title}</Title>
          <Text style={type.body}>{layer.summary}</Text>
          <Citations doc={doc} ids={[layer.source_id]} openUrl={openUrl} />
        </>
      );
    case 'quote':
      return (
        <>
          <View style={styles.quote}>
            <Text style={styles.quoteText}>“{layer.text}”</Text>
            <Text style={[type.small, styles.speaker]}>{layer.speaker}</Text>
            {layer.context ? <Text style={type.small}>{layer.context}</Text> : null}
          </View>
          <Citations doc={doc} ids={[layer.source_id]} openUrl={openUrl} />
        </>
      );
    case 'timeline':
      return (
        <>
          <Title>{layer.title}</Title>
          <View style={styles.timeline}>
            {layer.entries.map((entry, i) => (
              <View key={`${entry.date}-${i}`} style={styles.entry}>
                <Text style={[type.small, styles.entryDate]}>{formatDate(entry.date)}</Text>
                <View style={styles.entryBody}>
                  <Text style={type.body}>{entry.text}</Text>
                  <Citations doc={doc} ids={entry.source_ids} openUrl={openUrl} />
                </View>
              </View>
            ))}
          </View>
        </>
      );
    case 'context':
      return (
        <>
          <Title>{layer.title}</Title>
          <Text style={type.body}>{layer.body}</Text>
          <Citations doc={doc} ids={layer.source_ids} openUrl={openUrl} />
        </>
      );
  }
}

const styles = StyleSheet.create({
  list: { gap: space.lg, paddingTop: space.md },
  layer: {
    gap: space.sm,
    paddingLeft: space.md,
    borderLeftWidth: 1,
    borderLeftColor: colors.rule,
  },
  quote: { gap: space.xs },
  quoteText: { fontFamily: fonts.serif, fontSize: 19, lineHeight: 28, fontStyle: 'italic', color: colors.ink },
  speaker: { color: colors.ink },
  timeline: { gap: space.md },
  entry: { flexDirection: 'row', gap: space.md },
  entryDate: { width: 84, color: colors.ink, paddingTop: 3 },
  entryBody: { flex: 1, gap: space.xs },
});
