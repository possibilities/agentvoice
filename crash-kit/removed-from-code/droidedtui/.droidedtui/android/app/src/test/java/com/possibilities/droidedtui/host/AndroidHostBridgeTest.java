package com.possibilities.droidedtui.host;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

import org.junit.Test;

public final class AndroidHostBridgeTest {
    @Test
    public void normalizesDnsSdServiceTypesWithoutATrailingRootDot() {
        assertEquals("_agentvoice._tcp", AndroidHostBridge.normalizeServiceType("_agentvoice._tcp"));
        assertEquals("_agentvoice._tcp", AndroidHostBridge.normalizeServiceType("_agentvoice._tcp."));
    }

    @Test
    public void rejectsMalformedDnsSdServiceTypes() {
        assertThrows(
                IllegalArgumentException.class,
                () -> AndroidHostBridge.normalizeServiceType("agentvoice._tcp"));
        assertThrows(
                IllegalArgumentException.class,
                () -> AndroidHostBridge.normalizeServiceType("_agentvoice._sctp"));
    }

    @Test
    public void usesExecutorBackedDiscoveryRequestsWhereAndroidSupportsThem() {
        assertEquals(false, AndroidHostBridge.usesDiscoveryRequest(34));
        assertEquals(true, AndroidHostBridge.usesDiscoveryRequest(35));
        assertEquals(true, AndroidHostBridge.usesDiscoveryRequest(36));
    }

    @Test
    public void continuouslyMonitorsResolvedServicesWhereAndroidSupportsIt() {
        assertEquals(false, AndroidHostBridge.usesServiceInfoCallbacks(33));
        assertEquals(true, AndroidHostBridge.usesServiceInfoCallbacks(34));
        assertEquals(true, AndroidHostBridge.usesServiceInfoCallbacks(36));
    }

    @Test
    public void boundsKnownResolvingAndStillRegisteredServiceMonitorsTogether() {
        assertEquals(true, AndroidHostBridge.hasDiscoveryCapacity(63, 0, 63));
        assertEquals(false, AndroidHostBridge.hasDiscoveryCapacity(64, 0, 64));
        assertEquals(false, AndroidHostBridge.hasDiscoveryCapacity(32, 32, 32));
        assertEquals(false, AndroidHostBridge.hasDiscoveryCapacity(0, 0, 64));
    }
}
