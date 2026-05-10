import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Modal,
} from 'react-native';
import { X, QrCode } from 'lucide-react-native';
import Colors from '@/constants/colors';

interface SeedQRScannerProps {
  visible: boolean;
  onClose: () => void;
  onSeedScanned: (mnemonic: string) => void;
}

export default function SeedQRScanner({ visible, onClose }: SeedQRScannerProps) {
  return (
    <Modal visible={visible} animationType="slide" transparent={false}>
      <View style={styles.container}>
        <View style={styles.header}>
          <TouchableOpacity onPress={onClose} style={styles.closeButton}>
            <X size={24} color={Colors.text} />
          </TouchableOpacity>
          <Text style={styles.title}>Scanner SeedQR</Text>
        </View>

        <View style={styles.content}>
          <QrCode size={64} color={Colors.textMuted} />
          <Text style={styles.text}>
            Le scanner QR n'est pas disponible sur le web.
            Veuillez utiliser l'application mobile.
          </Text>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    paddingTop: 50,
    backgroundColor: Colors.surface,
  },
  closeButton: {
    padding: 8,
    marginRight: 16,
  },
  title: {
    fontSize: 18,
    fontWeight: '600' as const,
    color: Colors.text,
  },
  content: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
  },
  text: {
    marginTop: 16,
    fontSize: 16,
    color: Colors.textMuted,
    textAlign: 'center' as const,
  },
});
