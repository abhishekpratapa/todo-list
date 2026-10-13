// Scans the pairing code with the system's own scanner (VisionKit). What it reads
// stays inside the app: the code holds the access token.

import SwiftUI
import VisionKit

struct QRScanner: UIViewControllerRepresentable {
    var onScan: (String) -> Void

    /// False in the Simulator and on devices without the hardware for it.
    static var isSupported: Bool {
        DataScannerViewController.isSupported
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(onScan: onScan)
    }

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let scanner = DataScannerViewController(
            recognizedDataTypes: [.barcode(symbologies: [.qr])],
            qualityLevel: .balanced,
            recognizesMultipleItems: false,
            isHighFrameRateTrackingEnabled: false,
            isGuidanceEnabled: true,
            isHighlightingEnabled: true
        )
        scanner.delegate = context.coordinator
        return scanner
    }

    func updateUIViewController(_ scanner: DataScannerViewController, context: Context) {
        // Starting fails harmlessly until camera access has been granted; iOS asks the first time.
        if !scanner.isScanning { try? scanner.startScanning() }
    }

    static func dismantleUIViewController(_ scanner: DataScannerViewController, coordinator: Coordinator) {
        scanner.stopScanning()
    }

    @MainActor
    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        private let onScan: (String) -> Void
        private var delivered = false

        init(onScan: @escaping (String) -> Void) {
            self.onScan = onScan
        }

        func dataScanner(_ dataScanner: DataScannerViewController, didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]) {
            guard !delivered else { return }
            for case .barcode(let code) in addedItems {
                if let text = code.payloadStringValue {
                    delivered = true
                    dataScanner.stopScanning()
                    onScan(text)
                    return
                }
            }
        }

        func dataScanner(_ dataScanner: DataScannerViewController, becameUnavailableWithError error: DataScannerViewController.ScanningUnavailable) {
            // Camera access was refused or the camera is in use. The manual fields are still there.
        }
    }
}
