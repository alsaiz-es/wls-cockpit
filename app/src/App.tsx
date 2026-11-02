import { Navigate, Route, Routes } from 'react-router-dom'
import { Login } from '@/routes/Login'
import { Servers } from '@/routes/Servers'
import { RequireAuth } from '@/auth/RequireAuth'
import { AppShell } from '@/components/app-shell'
import { Dashboard } from '@/routes/Dashboard'
import { Deployments } from '@/routes/Deployments'
import { DataSources } from '@/routes/DataSources'
import { Logs } from '@/routes/Logs'
import { ServerDetails } from '@/routes/ServerDetails'
import { DataSourceDetails } from '@/routes/DataSourceDetails'
import { DeploymentDetails } from '@/routes/DeploymentDetails'
import { LogDetails } from '@/routes/LogDetails'
import { Jms } from '@/routes/Jms'
import { JmsDestinationDetails } from '@/routes/JmsDestinationDetails'
import { Jndi } from '@/routes/Jndi'
import { Jta, JtaDetails } from '@/routes/Jta'
import { ClusterDetails, Clusters } from '@/routes/Clusters'
import { WorkManagers } from '@/routes/WorkManagers'
import { NodeManager } from '@/routes/NodeManager'
import { DomainConfigSnapshots } from '@/routes/DomainConfigSnapshots'
import { ActionAudit } from '@/routes/ActionAudit'
import { Security } from '@/routes/Security'
import { Messaging } from '@/routes/Messaging'

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/connections" element={<Login />} />
      <Route element={<RequireAuth><AppShell /></RequireAuth>}>
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/servers" element={<Servers />} />
        <Route path="/servers/:serverName" element={<ServerDetails />} />
        <Route path="/clusters" element={<Clusters />} />
        <Route path="/clusters/:clusterName" element={<ClusterDetails />} />
        <Route path="/work-managers" element={<WorkManagers />} />
        <Route path="/node-manager" element={<NodeManager />} />
        <Route path="/deployments" element={<Deployments />} />
        <Route path="/deployments/:serverName/:deploymentName" element={<DeploymentDetails />} />
        <Route path="/data-sources" element={<DataSources />} />
        <Route path="/data-sources/:serverName/:dataSourceName" element={<DataSourceDetails />} />
        <Route path="/jms" element={<Jms />} />
        <Route path="/jms/:serverName/:jmsServerName/:destinationName" element={<JmsDestinationDetails />} />
        <Route path="/messaging" element={<Messaging />} />
        <Route path="/jndi" element={<Jndi />} />
        <Route path="/jta" element={<Jta />} />
        <Route path="/jta/:serverName" element={<JtaDetails />} />
        <Route path="/security" element={<Security />} />
        <Route path="/logs" element={<Logs />} />
        <Route path="/logs/:serverName" element={<LogDetails />} />
        <Route path="/config-snapshots" element={<DomainConfigSnapshots />} />
        <Route path="/audit" element={<ActionAudit />} />
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Route>
    </Routes>
  )
}
