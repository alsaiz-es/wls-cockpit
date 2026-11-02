import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.lang.management.ManagementFactory;
import java.net.InetAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.Hashtable;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Phaser;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import javax.management.MBeanServerConnection;
import javax.management.ObjectName;
import javax.management.openmbean.CompositeData;
import javax.management.openmbean.CompositeDataSupport;
import javax.management.openmbean.CompositeType;
import javax.management.openmbean.OpenType;
import javax.management.openmbean.SimpleType;
import javax.management.remote.JMXConnector;
import javax.management.remote.JMXConnectorFactory;
import javax.management.remote.JMXServiceURL;
import javax.naming.CompositeName;
import javax.naming.Context;
import javax.naming.InitialContext;
import javax.naming.NameClassPair;
import javax.naming.NamingEnumeration;
import javax.naming.NamingException;

public final class WlsJmsJmxHelper {
  private static final int BROWSE_TIMEOUT_MS = 1000;

  public static void main(String[] args) throws Exception {
    try {
      Map<String, Object> request = Json.asObject(Json.parse(readStdin()));
      String operation = requiredString(request, "operation");
      Map<String, Object> response;
      if ("browse".equals(operation)) {
        response = browse(request);
      } else if ("detail".equals(operation)) {
        response = detail(request);
      } else if ("delete".equals(operation)) {
        response = delete(request);
      } else if ("produce".equals(operation)) {
        response = produce(request);
      } else if ("jndi".equals(operation)) {
        response = jndi(request);
      } else {
        throw new HelperException("INVALID_REQUEST", "Unsupported JMS JMX helper operation.", false);
      }
      System.out.println(Json.stringify(response));
    } catch (HelperException error) {
      System.out.println(Json.stringify(errorResponse(error.code, error.getMessage(), error.retryable)));
    } catch (Throwable error) {
      System.out.println(Json.stringify(errorResponse("JMS_JMX_HELPER_FAILURE", safeMessage(error), true)));
    }
  }

  private static long phaseStart(String phase, String operation) {
    long started = System.currentTimeMillis();
    System.err.println("WLS_COCKPIT_JMS_JMX phase=" + phase + " operation=" + operation + " event=start");
    return started;
  }

  private static void phaseOk(String phase, long started) {
    phaseOk(phase, started, "");
  }

  private static void phaseOk(String phase, long started, String detail) {
    long elapsed = Math.max(0L, System.currentTimeMillis() - started);
    String suffix = detail == null || detail.length() == 0 ? "" : " " + detail;
    System.err.println("WLS_COCKPIT_JMS_JMX phase=" + phase + " event=ok elapsedMs=" + elapsed + suffix);
  }

  private static void phaseFailed(String phase, long started, Throwable error) {
    long elapsed = Math.max(0L, System.currentTimeMillis() - started);
    System.err.println(
      "WLS_COCKPIT_JMS_JMX phase=" + phase + " event=failed elapsedMs=" + elapsed + " error=" + error.getClass().getSimpleName()
    );
  }

  private static Map<String, Object> browse(Map<String, Object> request) throws Exception {
    int offset = requiredInt(request, "offset");
    int limit = requiredInt(request, "limit");
    if (offset < 0 || limit < 1 || limit > 50) {
      throw new HelperException("INVALID_REQUEST", "Browse offset or limit is outside the supported range.", false);
    }

    try (JmxSession session = JmxSession.open(request)) {
      ObjectName destination = session.findDestination();
      String cursor = null;
      List<Object> partialFailures = new ArrayList<Object>();
      try {
        long getMessagesStart = phaseStart("getMessages", "browse");
        cursor = (String) session.connection.invoke(
          destination,
          "getMessages",
          new Object[] { optionalString(request, "selector"), Integer.valueOf(BROWSE_TIMEOUT_MS) },
          new String[] { "java.lang.String", "java.lang.Integer" }
        );
        phaseOk("getMessages", getMessagesStart);
        long getCursorSizeStart = phaseStart("getCursorSize", "browse");
        Number size = (Number) session.connection.invoke(
          destination,
          "getCursorSize",
          new Object[] { cursor },
          new String[] { "java.lang.String" }
        );
        phaseOk("getCursorSize", getCursorSizeStart, "count=" + size.longValue());
        long getItemsStart = phaseStart("getItems", "browse");
        CompositeData[] rows = (CompositeData[]) session.connection.invoke(
          destination,
          "getItems",
          new Object[] { cursor, Long.valueOf(offset), Integer.valueOf(limit) },
          new String[] { "java.lang.String", "java.lang.Long", "java.lang.Integer" }
        );
        phaseOk("getItems", getItemsStart, "count=" + (rows == null ? 0 : rows.length));

        Map<String, Object> response = okResponse("browse");
        response.put("cursorSize", Long.valueOf(size.longValue()));
        response.put("offset", Integer.valueOf(offset));
        response.put("limit", Integer.valueOf(limit));
        response.put("messages", normalizeRows(rows, false));
        response.put("partialFailures", partialFailures);
        return response;
      } finally {
        if (cursor != null) {
          long closeCursorStart = phaseStart("closeCursor", "browse");
          try {
            session.connection.invoke(destination, "closeCursor", new Object[] { cursor }, new String[] { "java.lang.String" });
            phaseOk("closeCursor", closeCursorStart);
          } catch (Throwable closeError) {
            phaseFailed("closeCursor", closeCursorStart, closeError);
            Map<String, Object> failure = new LinkedHashMap<String, Object>();
            failure.put("code", "JMS_JMX_CURSOR_CLOSE_FAILED");
            failure.put("message", safeMessage(closeError));
            partialFailures.add(failure);
          }
        }
      }
    }
  }

  private static Map<String, Object> detail(Map<String, Object> request) throws Exception {
    String messageId = requiredString(request, "messageId");

    try (JmxSession session = JmxSession.open(request)) {
      ObjectName destination = session.findDestination();
      long getMessageStart = phaseStart("getMessage", "detail");
      CompositeData row = (CompositeData) session.connection.invoke(
        destination,
        "getMessage",
        new Object[] { messageId },
        new String[] { "java.lang.String" }
      );
      phaseOk("getMessage", getMessageStart);
      if (row == null) throw new HelperException("JMS_MESSAGE_NOT_FOUND", "JMS message was not found.", false);

      Map<String, Object> response = okResponse("detail");
      response.put("message", normalizeRow(row, true));
      return response;
    }
  }

  private static Map<String, Object> delete(Map<String, Object> request) throws Exception {
    List<String> messageIds = requiredStringList(request, "messageIds");

    try (JmxSession session = JmxSession.open(request)) {
      ObjectName destination = session.findDestination();
      int deleted = 0;
      int stale = 0;
      int failed = 0;
      for (String messageId : messageIds) {
        String selector = exactMessageIdSelector(messageId);
        long deleteMessagesStart = phaseStart("deleteMessages", "delete");
        try {
          Object result = session.connection.invoke(
            destination,
            "deleteMessages",
            new Object[] { selector },
            new String[] { "java.lang.String" }
          );
          int count = result instanceof Number ? ((Number) result).intValue() : 0;
          if (count > 0) deleted += count;
          else stale += 1;
          phaseOk("deleteMessages", deleteMessagesStart, "count=" + count);
        } catch (Throwable deleteError) {
          failed += 1;
          phaseFailed("deleteMessages", deleteMessagesStart, deleteError);
        }
      }
      Map<String, Object> response = okResponse("delete");
      response.put("requestedCount", Integer.valueOf(messageIds.size()));
      response.put("deletedCount", Integer.valueOf(deleted));
      response.put("failedCount", Integer.valueOf(failed));
      response.put("staleCount", Integer.valueOf(stale));
      response.put("stale", Boolean.valueOf(deleted == 0 && failed == 0 && stale > 0));
      return response;
    }
  }

  private static Map<String, Object> produce(Map<String, Object> request) throws Exception {
    String requestedDestinationType = requiredString(request, "destinationType");
    if (!isQueueDestinationType(requestedDestinationType)) {
      throw new HelperException("JMS_DESTINATION_NOT_QUEUE", "JMS message production is only available for queue destinations.", false);
    }
    String body = requiredString(request, "body");
    String correlationId = optionalString(request, "correlationId");
    Map<String, String> properties = optionalStringMap(request, "properties");
    int priority = optionalInt(request, "priority", 4);
    if (priority < 0 || priority > 9) throw new HelperException("INVALID_REQUEST", "JMS priority must be between 0 and 9.", false);
    String deliveryMode = optionalString(request, "deliveryMode");
    if (deliveryMode.length() == 0) deliveryMode = "NON_PERSISTENT";
    if (!"NON_PERSISTENT".equals(deliveryMode) && !"PERSISTENT".equals(deliveryMode)) {
      throw new HelperException("INVALID_REQUEST", "JMS delivery mode is unsupported.", false);
    }
    long ttlMillis = optionalLong(request, "ttlMillis", 0L);
    if (ttlMillis < 0) throw new HelperException("INVALID_REQUEST", "JMS TTL must be non-negative.", false);

    try (JmxSession session = JmxSession.open(request)) {
      ObjectName destination = session.findDestination();
      session.requireQueueDestination(destination);
      long now = System.currentTimeMillis();
      long expiration = ttlMillis > 0 ? now + ttlMillis : 0L;
      String xml = messageXml(body, correlationId, properties, priority, deliveryMode, now, expiration);
      CompositeData message = messageCompositeData(session.destinationName, xml);
      long importMessagesStart = phaseStart("importMessages", "produce");
      session.connection.invoke(
        destination,
        "importMessages",
        new Object[] { new CompositeData[] { message }, Boolean.FALSE },
        new String[] { "[Ljavax.management.openmbean.CompositeData;", "java.lang.Boolean" }
      );
      phaseOk("importMessages", importMessagesStart, "count=1");
      Map<String, Object> response = okResponse("produce");
      response.put("accepted", Boolean.TRUE);
      response.put("correlationId", correlationId.length() > 0 ? correlationId : null);
      response.put("messageSize", Integer.valueOf(body.length()));
      response.put("propertyCount", Integer.valueOf(properties.size()));
      response.put("priority", Integer.valueOf(priority));
      response.put("deliveryMode", deliveryMode);
      response.put("ttlMillis", Long.valueOf(ttlMillis));
      return response;
    }
  }

  private static CompositeData messageCompositeData(String destinationName, String xml) throws Exception {
    CompositeType type = new CompositeType(
      "JMSMessage",
      "JMSMessage",
      new String[] { "BodyIncluded", "ConsumerID", "DestinationName", "Handle", "MessageSize", "MessageXMLText", "SequenceNumber", "State", "VersionNumber", "XidString" },
      new String[] { "BodyIncluded", "ConsumerID", "DestinationName", "Handle", "MessageSize", "MessageXMLText", "SequenceNumber", "State", "VersionNumber", "XidString" },
      new OpenType[] { SimpleType.BOOLEAN, SimpleType.STRING, SimpleType.STRING, SimpleType.STRING, SimpleType.LONG, SimpleType.STRING, SimpleType.LONG, SimpleType.INTEGER, SimpleType.INTEGER, SimpleType.STRING }
    );
    Map<String, Object> values = new LinkedHashMap<String, Object>();
    values.put("BodyIncluded", Boolean.TRUE);
    values.put("ConsumerID", null);
    values.put("DestinationName", destinationName);
    values.put("Handle", null);
    values.put("MessageSize", Long.valueOf(xml.length()));
    values.put("MessageXMLText", xml);
    values.put("SequenceNumber", Long.valueOf(0L));
    values.put("State", Integer.valueOf(1));
    values.put("VersionNumber", Integer.valueOf(1));
    values.put("XidString", null);
    return new CompositeDataSupport(type, values);
  }

  private static String messageXml(String body, String correlationId, Map<String, String> properties, int priority, String deliveryMode, long timestamp, long expiration) {
    StringBuilder xml = new StringBuilder();
    xml.append("<mes:WLJMSMessage xmlns:mes=\"http://www.bea.com/WLS/JMS/Message\">\n");
    xml.append("  <mes:Header>\n");
    if (correlationId != null && correlationId.length() > 0) {
      xml.append("    <mes:JMSCorrelationID>").append(escapeXml(correlationId)).append("</mes:JMSCorrelationID>\n");
    }
    xml.append("    <mes:JMSDeliveryMode>").append(deliveryMode).append("</mes:JMSDeliveryMode>\n");
    xml.append("    <mes:JMSExpiration>").append(expiration).append("</mes:JMSExpiration>\n");
    xml.append("    <mes:JMSPriority>").append(priority).append("</mes:JMSPriority>\n");
    xml.append("    <mes:JMSRedelivered>false</mes:JMSRedelivered>\n");
    xml.append("    <mes:JMSTimestamp>").append(timestamp).append("</mes:JMSTimestamp>\n");
    if (!properties.isEmpty()) {
      xml.append("    <mes:Properties>\n");
      for (Map.Entry<String, String> entry : properties.entrySet()) {
        xml.append("      <mes:property name=\"").append(escapeXml(entry.getKey())).append("\"><mes:String>")
          .append(escapeXml(entry.getValue())).append("</mes:String></mes:property>\n");
      }
      xml.append("    </mes:Properties>\n");
    }
    xml.append("  </mes:Header>\n");
    xml.append("  <mes:Body><mes:Text>").append(escapeXml(body)).append("</mes:Text></mes:Body>\n");
    xml.append("</mes:WLJMSMessage>");
    return xml.toString();
  }

  private static List<Object> normalizeRows(CompositeData[] rows, boolean includePayload) {
    List<Object> normalized = new ArrayList<Object>();
    if (rows == null) return normalized;

    for (CompositeData row : rows) {
      normalized.add(normalizeRow(row, includePayload));
    }
    return normalized;
  }

  private static Map<String, Object> normalizeRow(CompositeData row, boolean includePayload) {
    Map<String, Object> item = new LinkedHashMap<String, Object>();
    String xml = stringValue(row, "MessageXMLText");
    String messageId = tagText(xml, "JMSMessageID");

    item.put("handle", stringValue(row, "Handle"));
    item.put("sequenceNumber", numberValue(row, "SequenceNumber"));
    item.put("state", stringValue(row, "State"));
    item.put("messageSize", numberValue(row, "MessageSize"));
    item.put("bodyIncluded", booleanValue(row, "BodyIncluded"));
    item.put("destinationName", stringValue(row, "DestinationName"));
    item.put("consumerId", stringValue(row, "ConsumerID"));
    item.put("xidString", stringValue(row, "XidString"));
    item.put("versionNumber", numberValue(row, "VersionNumber"));
    item.put("messageId", messageId);
    item.put("correlationId", tagText(xml, "JMSCorrelationID"));
    item.put("type", tagText(xml, "JMSType"));
    item.put("deliveryMode", tagText(xml, "JMSDeliveryMode"));
    item.put("priority", longTagValue(xml, "JMSPriority"));
    item.put("timestamp", longTagValue(xml, "JMSTimestamp"));
    item.put("expiration", longTagValue(xml, "JMSExpiration"));
    item.put("redelivered", booleanTagValue(xml, "JMSRedelivered"));
    item.put("properties", propertyShape(xml));
    item.put("deleteCapable", Boolean.valueOf(messageId != null && messageId.length() > 0));

    if (includePayload) {
      item.put("messageXmlText", xml);
      item.put("bodyText", bodyText(xml));
      item.put(
        "bodyUnavailableReason",
        Boolean.TRUE.equals(booleanValue(row, "BodyIncluded")) ? null : "WebLogic did not include the message body in this JMX response."
      );
    }

    return item;
  }

  private static Map<String, Object> propertyShape(String xml) {
    Map<String, Object> shape = new LinkedHashMap<String, Object>();
    List<Object> names = new ArrayList<Object>();
    if (xml != null) {
        Matcher matcher = Pattern.compile("<(?:\\w+:)?Property[^>]*\\bname=[\"']([^\"']+)[\"']", Pattern.CASE_INSENSITIVE).matcher(xml);
        while (matcher.find() && names.size() < 20) names.add(unescapeXml(matcher.group(1)));
    }
    shape.put("count", Integer.valueOf(names.size()));
    shape.put("names", names);
    return shape;
  }

  private static String bodyText(String xml) {
    if (xml == null) return null;
    String body = tagInner(xml, "JMSMessageBody");
    if (body == null) body = tagInner(xml, "Body");
    if (body == null) body = tagInner(xml, "Text");
    if (body == null) return null;

    String text = body.replaceAll("<[^>]+>", "").trim();
    return text.length() == 0 ? null : unescapeXml(text);
  }

  private static String tagText(String xml, String localName) {
    String inner = tagInner(xml, localName);
    if (inner == null) return null;
    String value = inner.replaceAll("<[^>]+>", "").trim();
    return value.length() == 0 ? null : unescapeXml(value);
  }

  private static String tagInner(String xml, String localName) {
    if (xml == null) return null;
    Matcher matcher = Pattern.compile(
      "<(?:\\w+:)?" + Pattern.quote(localName) + "\\b[^>]*>(.*?)</(?:\\w+:)?" + Pattern.quote(localName) + ">",
      Pattern.CASE_INSENSITIVE | Pattern.DOTALL
    ).matcher(xml);
    if (!matcher.find()) return null;
    String value = matcher.group(1).trim();
    return value.length() == 0 ? null : value;
  }

  private static String unescapeXml(String value) {
    if (value == null) return null;
    return value
      .replace("&lt;", "<")
      .replace("&gt;", ">")
      .replace("&quot;", "\"")
      .replace("&apos;", "'")
      .replace("&amp;", "&");
  }

  private static String escapeXml(String value) {
    if (value == null) return "";
    return value
      .replace("&", "&amp;")
      .replace("<", "&lt;")
      .replace(">", "&gt;")
      .replace("\"", "&quot;")
      .replace("'", "&apos;");
  }

  private static Long longTagValue(String xml, String localName) {
    String value = tagText(xml, localName);
    if (value == null) return null;
    try {
      return Long.valueOf(value);
    } catch (NumberFormatException ignored) {
      return null;
    }
  }

  private static Boolean booleanTagValue(String xml, String localName) {
    String value = tagText(xml, localName);
    if (value == null) return null;
    return Boolean.valueOf("true".equalsIgnoreCase(value));
  }

  private static String exactMessageIdSelector(String messageId) {
    return "JMSMessageID = '" + messageId.replace("'", "''") + "'";
  }

  private static String stringValue(CompositeData row, String key) {
    Object value = row.containsKey(key) ? row.get(key) : null;
    return value == null ? null : String.valueOf(value);
  }

  private static Long numberValue(CompositeData row, String key) {
    Object value = row.containsKey(key) ? row.get(key) : null;
    if (value instanceof Number) return Long.valueOf(((Number) value).longValue());
    return null;
  }

  private static Boolean booleanValue(CompositeData row, String key) {
    Object value = row.containsKey(key) ? row.get(key) : null;
    return value instanceof Boolean ? (Boolean) value : null;
  }

  private static String readStdin() throws Exception {
    InputStream in = System.in;
    ByteArrayOutputStream out = new ByteArrayOutputStream();
    byte[] buffer = new byte[8192];
    int read;
    while ((read = in.read(buffer)) >= 0) out.write(buffer, 0, read);
    return new String(out.toByteArray(), StandardCharsets.UTF_8);
  }

  private static String optionalString(Map<String, Object> map, String key) {
    Object value = map.get(key);
    return value instanceof String ? (String) value : "";
  }

  private static String requiredString(Map<String, Object> map, String key) throws HelperException {
    Object value = map.get(key);
    if (!(value instanceof String) || ((String) value).length() == 0) {
      throw new HelperException("INVALID_REQUEST", "Missing required helper field: " + key, false);
    }
    return (String) value;
  }

  private static int requiredInt(Map<String, Object> map, String key) throws HelperException {
    Object value = map.get(key);
    if (!(value instanceof Number)) throw new HelperException("INVALID_REQUEST", "Missing numeric helper field: " + key, false);
    return ((Number) value).intValue();
  }

  private static List<String> requiredStringList(Map<String, Object> map, String key) throws HelperException {
    Object value = map.get(key);
    List<String> result = new ArrayList<String>();
    if (value instanceof List) {
      for (Object item : (List<?>) value) {
        if (!(item instanceof String) || ((String) item).length() == 0) {
          throw new HelperException("INVALID_REQUEST", "Invalid helper string list field: " + key, false);
        }
        result.add((String) item);
      }
    } else if (map.get("messageId") instanceof String) {
      result.add((String) map.get("messageId"));
    } else {
      throw new HelperException("INVALID_REQUEST", "Missing helper string list field: " + key, false);
    }
    if (result.isEmpty() || result.size() > 50) {
      throw new HelperException("INVALID_REQUEST", "Helper string list field is outside the supported range: " + key, false);
    }
    return result;
  }

  private static int optionalInt(Map<String, Object> map, String key, int fallback) throws HelperException {
    Object value = map.get(key);
    if (value == null) return fallback;
    if (!(value instanceof Number)) throw new HelperException("INVALID_REQUEST", "Invalid numeric helper field: " + key, false);
    return ((Number) value).intValue();
  }

  private static long optionalLong(Map<String, Object> map, String key, long fallback) throws HelperException {
    Object value = map.get(key);
    if (value == null) return fallback;
    if (!(value instanceof Number)) throw new HelperException("INVALID_REQUEST", "Invalid numeric helper field: " + key, false);
    return ((Number) value).longValue();
  }

  @SuppressWarnings("unchecked")
  private static Map<String, String> optionalStringMap(Map<String, Object> map, String key) throws HelperException {
    Object value = map.get(key);
    Map<String, String> result = new LinkedHashMap<String, String>();
    if (value == null) return result;
    if (!(value instanceof Map)) throw new HelperException("INVALID_REQUEST", "Invalid helper map field: " + key, false);
    for (Map.Entry<String, Object> entry : ((Map<String, Object>) value).entrySet()) {
      if (!(entry.getValue() instanceof String)) throw new HelperException("INVALID_REQUEST", "Invalid helper string map field: " + key, false);
      result.put(entry.getKey(), (String) entry.getValue());
    }
    return result;
  }

  private static final int JNDI_MAX_BINDINGS = 2000;
  private static final int JNDI_MAX_DEPTH = 10;

  // JNDI read from the selected server over T3. WebLogic 12.2.1.4 has no JNDI resource in its REST
  // API. Context.list is used, not listBindings, so bound objects are never instantiated locally.
  private static Map<String, Object> jndi(Map<String, Object> request) throws Exception {
    String serverName = requiredString(request, "serverName");
    URI target = URI.create(requiredString(request, "targetUrl"));
    String protocol = "https".equalsIgnoreCase(target.getScheme()) ? "t3s" : "t3";
    String host = target.getHost();
    int port = target.getPort();
    if (port < 1) port = "t3s".equals(protocol) ? 443 : 80;
    if (host == null) throw new HelperException("INVALID_TARGET", "Target URL must include a host.", false);

    String[] resolved = serverProviderUrl(request, protocol, host, port, serverName);
    String providerUrl = resolved[0];
    if ("fallback".equals(resolved[1])) verifyServerIdentity(request, providerUrl, serverName);
    Hashtable<String, Object> env = new Hashtable<String, Object>();
    env.put(Context.INITIAL_CONTEXT_FACTORY, "weblogic.jndi.WLInitialContextFactory");
    env.put(Context.PROVIDER_URL, providerUrl);
    env.put(Context.SECURITY_PRINCIPAL, requiredString(request, "username"));
    env.put(Context.SECURITY_CREDENTIALS, requiredString(request, "password"));
    env.put("weblogic.jndi.connectTimeout", "10000");
    env.put("weblogic.jndi.responseReadTimeout", "10000");

    long connectStart = phaseStart("jndi-connect", "jndi");
    InitialContext context;
    try {
      context = new InitialContext(env);
    } catch (NamingException error) {
      throw new HelperException("JNDI_CONNECT_FAILED", "Could not open JNDI on " + serverName + " at " + providerUrl + ": " + safeMessage(error), true);
    }
    phaseOk("jndi-connect", connectStart);
    try {
      List<Map<String, Object>> bindings = new ArrayList<Map<String, Object>>();
      long listStart = phaseStart("jndi-list", "jndi");
      String truncatedReason = listJndiTree(context, bindings);
      phaseOk("jndi-list", listStart, "count=" + bindings.size());
      Map<String, Object> response = okResponse("jndi");
      response.put("serverName", serverName);
      response.put("truncated", Boolean.valueOf(truncatedReason != null));
      if (truncatedReason != null) response.put("truncatedReason", truncatedReason);
      response.put("jndi", bindings);
      return response;
    } finally {
      context.close();
    }
  }

  // The JNDI tree is per server, so a managed server is reached on its own listen address. Its
  // DefaultURL comes from the domain runtime; when that host is loopback (empty listen address) or
  // does not resolve from this machine (a VM-internal hostname), the target host is used with the
  // server's port. Returns the URL and whether that fallback was used.
  private static String[] serverProviderUrl(Map<String, Object> request, String protocol, String host, int port, String serverName) throws Exception {
    String jmxUrl = "service:jmx:" + protocol + "://" + host + ":" + port + "/jndi/weblogic.management.mbeanservers.domainruntime";
    Map<String, Object> env = new HashMap<String, Object>();
    env.put(Context.SECURITY_PRINCIPAL, requiredString(request, "username"));
    env.put(Context.SECURITY_CREDENTIALS, requiredString(request, "password"));
    env.put(JMXConnectorFactory.PROTOCOL_PROVIDER_PACKAGES, "weblogic.management.remote");
    env.put("weblogic.jndi.connectTimeout", "10000");
    env.put("weblogic.jndi.responseReadTimeout", "10000");
    long start = phaseStart("connect", "jndi");
    JMXConnector connector = JMXConnectorFactory.connect(new JMXServiceURL(jmxUrl), env);
    phaseOk("connect", start);
    try {
      MBeanServerConnection connection = connector.getMBeanServerConnection();
      // Domain runtime names carry Location=<server>, so the runtime is found by pattern.
      Set<ObjectName> runtimes = connection.queryNames(new ObjectName("com.bea:Type=ServerRuntime,Name=" + serverName + ",*"), null);
      if (runtimes.isEmpty()) {
        throw new HelperException("JNDI_SERVER_NOT_RUNNING", serverName + " is not running, so its JNDI tree cannot be read.", true);
      }
      Object value = connection.getAttribute(runtimes.iterator().next(), "DefaultURL");
      String defaultUrl = value == null ? null : value.toString();
      if (defaultUrl == null || defaultUrl.trim().isEmpty()) return new String[] {protocol + "://" + host + ":" + port, "fallback"};
      URI server = URI.create(defaultUrl.trim());
      String serverHost = server.getHost();
      int serverPort = server.getPort() > 0 ? server.getPort() : port;
      String scheme = server.getScheme() != null ? server.getScheme() : protocol;
      if (serverHost != null && reachableFromHere(serverHost)) return new String[] {scheme + "://" + serverHost + ":" + serverPort, "direct"};
      return new String[] {scheme + "://" + host + ":" + serverPort, "fallback"};
    } finally {
      connector.close();
    }
  }

  // With the target host substituted, another server of the same machine may listen on that port.
  // Its runtime MBean server names the server that answered, so a different tree is never shown
  // under this server's name.
  private static void verifyServerIdentity(Map<String, Object> request, String providerUrl, String serverName) throws Exception {
    URI url = URI.create(providerUrl);
    String jmxUrl = "service:jmx:" + url.getScheme() + "://" + url.getHost() + ":" + url.getPort() + "/jndi/weblogic.management.mbeanservers.runtime";
    Map<String, Object> env = new HashMap<String, Object>();
    env.put(Context.SECURITY_PRINCIPAL, requiredString(request, "username"));
    env.put(Context.SECURITY_CREDENTIALS, requiredString(request, "password"));
    env.put(JMXConnectorFactory.PROTOCOL_PROVIDER_PACKAGES, "weblogic.management.remote");
    env.put("weblogic.jndi.connectTimeout", "10000");
    env.put("weblogic.jndi.responseReadTimeout", "10000");
    long start = phaseStart("jndi-identity", "jndi");
    String answered;
    JMXConnector connector;
    try {
      connector = JMXConnectorFactory.connect(new JMXServiceURL(jmxUrl), env);
    } catch (Exception error) {
      throw new HelperException("JNDI_CONNECT_FAILED", "Could not reach " + serverName + " at " + providerUrl + ": " + safeMessage(error), true);
    }
    try {
      Object value = connector.getMBeanServerConnection().getAttribute(
          new ObjectName("com.bea:Name=RuntimeService,Type=weblogic.management.mbeanservers.runtime.RuntimeServiceMBean"), "ServerName");
      answered = value == null ? null : value.toString();
    } finally {
      connector.close();
    }
    if (!serverName.equals(answered)) {
      throw new HelperException(
          "JNDI_SERVER_ADDRESS_MISMATCH",
          serverName + " has no listen address reachable from this machine, and " + providerUrl + " answered as " + (answered == null ? "an unknown server" : answered) + ". Set a listen address for " + serverName + " to browse its JNDI tree.",
          false);
    }
    phaseOk("jndi-identity", start);
  }

  private static boolean reachableFromHere(String host) {
    try {
      InetAddress address = InetAddress.getByName(host);
      return !address.isLoopbackAddress() && !address.isAnyLocalAddress();
    } catch (Exception error) {
      return false;
    }
  }

  private static boolean isJndiContext(String className) {
    if (className == null) return false;
    return className.endsWith("NamingNode") || className.equals("javax.naming.Context") || className.endsWith(".Context");
  }

  private static final int JNDI_LIST_THREADS = 8;
  private static final long JNDI_LIST_BUDGET_MS = 24000;

  // Each Context.list is a T3 round trip (about 0.2 s on a lab domain) and a server has from
  // dozens to hundreds of contexts, so subcontexts are listed in parallel. They are walked through
  // the context objects, not by names rebuilt from the root: application naming nodes (for
  // example under __WL_GlobalJavaApp, with spaces in their names) do not resolve from the root.
  // Returns why the result is incomplete ("bindings" or "time"), or null when it is complete.
  private static String listJndiTree(Context root, List<Map<String, Object>> out) throws InterruptedException {
    // Daemon threads: a list still blocked in T3 after the budget must not keep the JVM alive, or
    // the partial result would be lost to the caller's process timeout.
    ExecutorService pool = Executors.newFixedThreadPool(JNDI_LIST_THREADS, runnable -> {
      Thread thread = new Thread(runnable, "jndi-list");
      thread.setDaemon(true);
      return thread;
    });
    Phaser pending = new Phaser(1);
    AtomicBoolean capped = new AtomicBoolean(false);
    boolean outOfTime = false;
    try {
      submitJndiList(pool, pending, capped, root, "", 0, false, out);
      try {
        pending.awaitAdvanceInterruptibly(pending.arrive(), JNDI_LIST_BUDGET_MS, TimeUnit.MILLISECONDS);
      } catch (java.util.concurrent.TimeoutException error) {
        outOfTime = true;
        capped.set(true);
      }
    } finally {
      pool.shutdownNow();
    }
    synchronized (out) {
      out.sort(Comparator.comparing((Map<String, Object> entry) -> String.valueOf(entry.get("context"))).thenComparing(entry -> String.valueOf(entry.get("name"))));
    }
    return outOfTime ? "time" : capped.get() ? "bindings" : null;
  }

  private static void submitJndiList(
      ExecutorService pool,
      Phaser pending,
      AtomicBoolean capped,
      Context context,
      String path,
      int depth,
      boolean closeWhenDone,
      List<Map<String, Object>> out) {
    pending.register();
    pool.execute(() -> {
      try {
        listJndiContext(pool, pending, capped, context, path, depth, out);
      } finally {
        if (closeWhenDone) {
          try {
            context.close();
          } catch (NamingException ignored) {
            // Closing a remote subcontext stub only releases local state.
          }
        }
        pending.arriveAndDeregister();
      }
    });
  }

  private static void listJndiContext(
      ExecutorService pool, Phaser pending, AtomicBoolean capped, Context context, String path, int depth, List<Map<String, Object>> out) {
    try {
      NamingEnumeration<NameClassPair> entries = context.list("");
      while (entries.hasMore()) {
        if (capped.get()) return;
        NameClassPair pair = entries.next();
        String name = pair.getName();
        String className = pair.getClassName();
        String child = path.isEmpty() ? name : path + "." + name;
        if (isJndiContext(className) && depth < JNDI_MAX_DEPTH) {
          Context subcontext;
          try {
            // Only contexts are looked up; bound objects are never instantiated locally.
            subcontext = (Context) context.lookup(new CompositeName().add(name));
          } catch (NamingException | ClassCastException error) {
            addJndiEntry(out, capped, jndiEntry(child, "", null, safeMessage(error)));
            continue;
          }
          submitJndiList(pool, pending, capped, subcontext, child, depth + 1, true, out);
        } else {
          addJndiEntry(out, capped, jndiEntry(name, path, className, null));
        }
      }
    } catch (NamingException error) {
      addJndiEntry(out, capped, jndiEntry(path.isEmpty() ? "(root)" : path, "", null, safeMessage(error)));
    }
  }

  private static void addJndiEntry(List<Map<String, Object>> out, AtomicBoolean capped, Map<String, Object> entry) {
    synchronized (out) {
      // After the cap or the time budget, late listings are dropped so the result stays stable.
      if (capped.get()) return;
      if (out.size() >= JNDI_MAX_BINDINGS) {
        capped.set(true);
        return;
      }
      out.add(entry);
    }
  }

  private static Map<String, Object> jndiEntry(String name, String context, String className, String error) {
    Map<String, Object> entry = new LinkedHashMap<String, Object>();
    entry.put("name", name);
    entry.put("context", context);
    entry.put("class", className);
    if (error != null) entry.put("error", error);
    return entry;
  }

  private static Map<String, Object> okResponse(String operation) {
    Map<String, Object> response = new LinkedHashMap<String, Object>();
    response.put("ok", Boolean.TRUE);
    response.put("operation", operation);
    return response;
  }

  private static Map<String, Object> errorResponse(String code, String message, boolean retryable) {
    Map<String, Object> response = new LinkedHashMap<String, Object>();
    Map<String, Object> error = new LinkedHashMap<String, Object>();
    response.put("ok", Boolean.FALSE);
    error.put("code", code);
    error.put("message", message);
    error.put("retryable", Boolean.valueOf(retryable));
    response.put("error", error);
    return response;
  }

  private static String safeMessage(Throwable error) {
    String message = error.getMessage();
    if (message == null || message.trim().length() == 0) return error.getClass().getSimpleName();
    return message.replaceAll("(?i)(password|credential|authorization)=[^,\\s]+", "$1=<redacted>");
  }

  private static final class JmxSession implements AutoCloseable {
    final JMXConnector connector;
    final MBeanServerConnection connection;
    final String serverName;
    final String jmsServerName;
    final String destinationName;

    private JmxSession(JMXConnector connector, MBeanServerConnection connection, String serverName, String jmsServerName, String destinationName) {
      this.connector = connector;
      this.connection = connection;
      this.serverName = serverName;
      this.jmsServerName = jmsServerName;
      this.destinationName = destinationName;
    }

    static JmxSession open(Map<String, Object> request) throws Exception {
      URI target = URI.create(requiredString(request, "targetUrl"));
      String protocol = "https".equalsIgnoreCase(target.getScheme()) ? "t3s" : "t3";
      String host = target.getHost();
      int port = target.getPort();
      if (port < 1) port = "t3s".equals(protocol) ? 443 : 80;
      if (host == null || port < 1) throw new HelperException("INVALID_TARGET", "Target URL must include a host and port.", false);

      String jmxUrl = "service:jmx:" + protocol + "://" + host + ":" + port + "/jndi/weblogic.management.mbeanservers.domainruntime";
      Map<String, Object> env = new HashMap<String, Object>();
      env.put(Context.SECURITY_PRINCIPAL, requiredString(request, "username"));
      env.put(Context.SECURITY_CREDENTIALS, requiredString(request, "password"));
      env.put(JMXConnectorFactory.PROTOCOL_PROVIDER_PACKAGES, "weblogic.management.remote");
      env.put("weblogic.jndi.connectTimeout", "10000");
      env.put("weblogic.jndi.responseReadTimeout", "10000");
      env.put("jmx.remote.x.request.waiting.timeout", Long.valueOf(10000L));

      long connectStart = phaseStart("connect", requiredString(request, "operation"));
      JMXConnector connector = JMXConnectorFactory.connect(new JMXServiceURL(jmxUrl), env);
      phaseOk("connect", connectStart);
      return new JmxSession(
        connector,
        connector.getMBeanServerConnection(),
        requiredString(request, "serverName"),
        requiredString(request, "jmsServerName"),
        requiredString(request, "destinationName")
      );
    }

    ObjectName findDestination() throws Exception {
      long queryStart = phaseStart("queryNames", "lookup");
      Set<ObjectName> names = connection.queryNames(new ObjectName("com.bea:Type=JMSDestinationRuntime,*"), null);
      phaseOk("queryNames", queryStart, "count=" + names.size());
      List<ObjectName> sorted = new ArrayList<ObjectName>(names);
      sorted.sort(Comparator.comparing(ObjectName::getCanonicalName));
      for (ObjectName candidate : sorted) {
        if (
          serverName.equals(candidate.getKeyProperty("ServerRuntime")) &&
          jmsServerName.equals(candidate.getKeyProperty("JMSServerRuntime")) &&
          destinationName.equals(candidate.getKeyProperty("Name"))
        ) {
          return candidate;
        }
      }
      throw new HelperException("JMS_DESTINATION_NOT_FOUND", "JMS destination runtime was not found for the selected server and JMS server.", true);
    }

    void requireQueueDestination(ObjectName destination) throws Exception {
      Object value;
      try {
        value = connection.getAttribute(destination, "DestinationType");
      } catch (Exception error) {
        throw new HelperException("JMS_DESTINATION_TYPE_UNAVAILABLE", "JMS destination type could not be verified for message production.", true);
      }
      String destinationType = value == null ? "" : String.valueOf(value);
      if (!isQueueDestinationType(destinationType)) {
        throw new HelperException("JMS_DESTINATION_NOT_QUEUE", "JMS message production is only available for queue destinations.", false);
      }
    }

    public void close() throws Exception {
      connector.close();
    }
  }

  private static boolean isQueueDestinationType(String destinationType) {
    return destinationType != null && destinationType.toUpperCase().contains("QUEUE");
  }

  private static final class HelperException extends Exception {
    final String code;
    final boolean retryable;

    HelperException(String code, String message, boolean retryable) {
      super(message);
      this.code = code;
      this.retryable = retryable;
    }
  }

  private static final class Json {
    static Object parse(String text) throws HelperException {
      return new Parser(text).parse();
    }

    @SuppressWarnings("unchecked")
    static Map<String, Object> asObject(Object value) throws HelperException {
      if (value instanceof Map) return (Map<String, Object>) value;
      throw new HelperException("INVALID_REQUEST", "Helper input must be a JSON object.", false);
    }

    static String stringify(Object value) {
      StringBuilder out = new StringBuilder();
      writeJson(out, value);
      return out.toString();
    }

    @SuppressWarnings("unchecked")
    private static void writeJson(StringBuilder out, Object value) {
      if (value == null) {
        out.append("null");
      } else if (value instanceof String) {
        out.append('"');
        String text = (String) value;
        for (int i = 0; i < text.length(); i++) {
          char c = text.charAt(i);
          if (c == '"' || c == '\\') out.append('\\').append(c);
          else if (c == '\n') out.append("\\n");
          else if (c == '\r') out.append("\\r");
          else if (c == '\t') out.append("\\t");
          else if (c < 0x20) out.append(String.format("\\u%04x", Integer.valueOf(c)));
          else out.append(c);
        }
        out.append('"');
      } else if (value instanceof Number || value instanceof Boolean) {
        out.append(String.valueOf(value));
      } else if (value instanceof Map) {
        out.append('{');
        boolean first = true;
        for (Map.Entry<String, Object> entry : ((Map<String, Object>) value).entrySet()) {
          if (!first) out.append(',');
          first = false;
          writeJson(out, entry.getKey());
          out.append(':');
          writeJson(out, entry.getValue());
        }
        out.append('}');
      } else if (value instanceof Iterable) {
        out.append('[');
        boolean first = true;
        for (Object child : (Iterable<Object>) value) {
          if (!first) out.append(',');
          first = false;
          writeJson(out, child);
        }
        out.append(']');
      } else {
        writeJson(out, String.valueOf(value));
      }
    }

    private static final class Parser {
      final String text;
      int index;

      Parser(String text) {
        this.text = text == null ? "" : text;
      }

      Object parse() throws HelperException {
        Object value = readValue();
        skipWhitespace();
        if (index != text.length()) throw error();
        return value;
      }

      private Object readValue() throws HelperException {
        skipWhitespace();
        if (index >= text.length()) throw error();
        char c = text.charAt(index);
        if (c == '{') return readObject();
        if (c == '[') return readArray();
        if (c == '"') return readString();
        if (c == 't' && text.startsWith("true", index)) {
          index += 4;
          return Boolean.TRUE;
        }
        if (c == 'f' && text.startsWith("false", index)) {
          index += 5;
          return Boolean.FALSE;
        }
        if (c == 'n' && text.startsWith("null", index)) {
          index += 4;
          return null;
        }
        if (c == '-' || (c >= '0' && c <= '9')) return readNumber();
        throw error();
      }

      private Map<String, Object> readObject() throws HelperException {
        Map<String, Object> object = new LinkedHashMap<String, Object>();
        index++;
        skipWhitespace();
        if (consume('}')) return object;
        while (true) {
          skipWhitespace();
          String key = readString();
          skipWhitespace();
          if (!consume(':')) throw error();
          object.put(key, readValue());
          skipWhitespace();
          if (consume('}')) return object;
          if (!consume(',')) throw error();
        }
      }

      private List<Object> readArray() throws HelperException {
        List<Object> array = new ArrayList<Object>();
        index++;
        skipWhitespace();
        if (consume(']')) return array;
        while (true) {
          array.add(readValue());
          skipWhitespace();
          if (consume(']')) return array;
          if (!consume(',')) throw error();
        }
      }

      private String readString() throws HelperException {
        if (!consume('"')) throw error();
        StringBuilder out = new StringBuilder();
        while (index < text.length()) {
          char c = text.charAt(index++);
          if (c == '"') return out.toString();
          if (c == '\\') {
            if (index >= text.length()) throw error();
            char escaped = text.charAt(index++);
            if (escaped == '"' || escaped == '\\' || escaped == '/') out.append(escaped);
            else if (escaped == 'b') out.append('\b');
            else if (escaped == 'f') out.append('\f');
            else if (escaped == 'n') out.append('\n');
            else if (escaped == 'r') out.append('\r');
            else if (escaped == 't') out.append('\t');
            else if (escaped == 'u') {
              if (index + 4 > text.length()) throw error();
              out.append((char) Integer.parseInt(text.substring(index, index + 4), 16));
              index += 4;
            } else {
              throw error();
            }
          } else {
            out.append(c);
          }
        }
        throw error();
      }

      private Number readNumber() throws HelperException {
        int start = index;
        if (text.charAt(index) == '-') index++;
        while (index < text.length() && Character.isDigit(text.charAt(index))) index++;
        if (index < text.length() && text.charAt(index) == '.') {
          index++;
          while (index < text.length() && Character.isDigit(text.charAt(index))) index++;
          return Double.valueOf(text.substring(start, index));
        }
        return Long.valueOf(text.substring(start, index));
      }

      private boolean consume(char expected) {
        if (index < text.length() && text.charAt(index) == expected) {
          index++;
          return true;
        }
        return false;
      }

      private void skipWhitespace() {
        while (index < text.length() && Character.isWhitespace(text.charAt(index))) index++;
      }

      private HelperException error() {
        return new HelperException("INVALID_JSON", "Helper input is not valid JSON.", false);
      }
    }
  }
}
