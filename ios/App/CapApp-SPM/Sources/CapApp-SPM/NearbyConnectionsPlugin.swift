import Capacitor
import CoreLocation
import Foundation
import NearbyConnections
import UIKit
import UserNotifications

@objc(NearbyConnectionsPlugin)
public class NearbyConnectionsPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NearbyConnectionsPlugin"
    public let jsName = "NearbyConnections"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestPermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestNotificationPermission", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startAdvertising", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopAdvertising", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startDiscovery", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopDiscovery", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setKeepAwake", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestConnection", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "acceptVerification", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "send", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "disconnect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
    ]

    private let serviceID = "uk.co.oliverdelange.tiles.nearby"
    private let locationManager = CLLocationManager()
    private var manager: ConnectionManager?
    private var advertiser: Advertiser?
    private var discoverer: Discoverer?
    private var endpointNames: [EndpointID: String] = [:]
    private var verifications: [EndpointID: (Bool) -> Void] = [:]
    private var localName = "Tiles player"
    private var isAdvertising = false
    private var isDiscovering = false

    @objc public func isAvailable(_ call: CAPPluginCall) { call.resolve(["available": true]) }

    @objc public override func requestPermissions(_ call: CAPPluginCall) {
        locationManager.requestWhenInUseAuthorization()
        call.resolve(["nearby": "prompted"])
    }

    @objc public func requestNotificationPermission(_ call: CAPPluginCall) {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in
            call.resolve()
        }
    }

    private func configure() -> ConnectionManager {
        let value = ConnectionManager(serviceID: serviceID, strategy: .star)
        value.delegate = self
        manager = value
        return value
    }

    @objc public func startAdvertising(_ call: CAPPluginCall) {
        localName = call.getString("name") ?? localName
        if isAdvertising { call.resolve(); return }
        let value: Advertiser
        if let current = advertiser {
            value = current
        } else {
            value = Advertiser(connectionManager: manager ?? configure())
            value.delegate = self
            advertiser = value
        }
        isAdvertising = true
        value.startAdvertising(using: Data(localName.utf8))
        call.resolve()
    }

    @objc public func stopAdvertising(_ call: CAPPluginCall) {
        if !isAdvertising { call.resolve(); return }
        isAdvertising = false
        advertiser?.stopAdvertising()
        call.resolve()
    }

    @objc public func startDiscovery(_ call: CAPPluginCall) {
        localName = call.getString("name") ?? localName
        if isDiscovering { call.resolve(); return }
        let value: Discoverer
        if let current = discoverer {
            value = current
        } else {
            value = Discoverer(connectionManager: manager ?? configure())
            value.delegate = self
            discoverer = value
        }
        isDiscovering = true
        value.startDiscovery()
        call.resolve()
    }

    @objc public func stopDiscovery(_ call: CAPPluginCall) {
        if !isDiscovering { call.resolve(); return }
        isDiscovering = false
        discoverer?.stopDiscovery()
        call.resolve()
    }

    @objc public func setKeepAwake(_ call: CAPPluginCall) {
        let enabled = call.getBool("enabled") ?? false
        DispatchQueue.main.async {
            UIApplication.shared.isIdleTimerDisabled = enabled
            call.resolve()
        }
    }

    @objc public func requestConnection(_ call: CAPPluginCall) {
        guard let endpointID = call.getString("endpointId") else { call.reject("endpointId is required"); return }
        discoverer?.requestConnection(to: endpointID, using: Data(localName.utf8))
        call.resolve()
    }

    @objc public func acceptVerification(_ call: CAPPluginCall) {
        guard let endpointID = call.getString("endpointId"), let handler = verifications.removeValue(forKey: endpointID) else {
            call.reject("No pending verification"); return
        }
        UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: ["invite-\(endpointID)"])
        UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: ["invite-\(endpointID)"])
        handler(call.getBool("accept") ?? false)
        call.resolve()
    }

    @objc public func send(_ call: CAPPluginCall) {
        guard let endpointIDs = call.getArray("endpointIds", String.self), let payload = call.getString("payload") else {
            call.reject("endpointIds and payload are required"); return
        }
        _ = manager?.send(Data(payload.utf8), to: endpointIDs, id: .unique())
        call.resolve()
    }

    @objc public func disconnect(_ call: CAPPluginCall) {
        if let endpointID = call.getString("endpointId") { manager?.disconnect(from: endpointID) }
        call.resolve()
    }

    @objc public func stop(_ call: CAPPluginCall) {
        isAdvertising = false
        isDiscovering = false
        advertiser?.stopAdvertising()
        discoverer?.stopDiscovery()
        advertiser = nil
        discoverer = nil
        manager = nil
        DispatchQueue.main.async { UIApplication.shared.isIdleTimerDisabled = false }
        call.resolve()
    }

    private func endpoint(_ id: EndpointID) -> [String: Any] {
        ["endpointId": id, "name": endpointNames[id] ?? "Nearby player"]
    }
}

extension NearbyConnectionsPlugin: DiscovererDelegate {
    public func discoverer(_ discoverer: Discoverer, didFind endpointID: EndpointID, with context: Data) {
        endpointNames[endpointID] = String(data: context, encoding: .utf8) ?? "Nearby game"
        notifyListeners("endpointFound", data: endpoint(endpointID))
    }
    public func discoverer(_ discoverer: Discoverer, didLose endpointID: EndpointID) {
        notifyListeners("endpointLost", data: endpoint(endpointID))
    }
}

extension NearbyConnectionsPlugin: AdvertiserDelegate {
    public func advertiser(_ advertiser: Advertiser, didReceiveConnectionRequestFrom endpointID: EndpointID, with context: Data, connectionRequestHandler: @escaping (Bool) -> Void) {
        endpointNames[endpointID] = String(data: context, encoding: .utf8) ?? "Nearby player"
        let content = UNMutableNotificationContent()
        content.title = "Tiles game invitation"
        content.body = "\(endpointNames[endpointID] ?? "A nearby player") invited you to play"
        content.sound = .default
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "invite-\(endpointID)", content: content, trigger: nil))
        connectionRequestHandler(true)
    }
}

extension NearbyConnectionsPlugin: ConnectionManagerDelegate {
    public func connectionManager(_ connectionManager: ConnectionManager, didReceive verificationCode: String, from endpointID: EndpointID, verificationHandler: @escaping (Bool) -> Void) {
        verifications[endpointID] = verificationHandler
        var data = endpoint(endpointID)
        data["code"] = verificationCode
        notifyListeners("verificationRequired", data: data)
    }

    public func connectionManager(_ connectionManager: ConnectionManager, didReceive data: Data, withID payloadID: PayloadID, from endpointID: EndpointID) {
        guard let payload = String(data: data, encoding: .utf8) else { return }
        var value = endpoint(endpointID)
        value["payload"] = payload
        notifyListeners("payloadReceived", data: value)
    }

    public func connectionManager(_ connectionManager: ConnectionManager, didReceive stream: InputStream, withID payloadID: PayloadID, from endpointID: EndpointID, cancellationToken token: CancellationToken) {}
    public func connectionManager(_ connectionManager: ConnectionManager, didStartReceivingResourceWithID payloadID: PayloadID, from endpointID: EndpointID, at localURL: URL, withName name: String, cancellationToken token: CancellationToken) {}
    public func connectionManager(_ connectionManager: ConnectionManager, didReceiveTransferUpdate update: TransferUpdate, from endpointID: EndpointID, forPayload payloadID: PayloadID) {}

    public func connectionManager(_ connectionManager: ConnectionManager, didChangeTo state: ConnectionState, for endpointID: EndpointID) {
        switch state {
        case .connected: notifyListeners("connected", data: endpoint(endpointID))
        case .disconnected, .rejected: notifyListeners("disconnected", data: endpoint(endpointID))
        case .connecting: break
        }
    }
}
