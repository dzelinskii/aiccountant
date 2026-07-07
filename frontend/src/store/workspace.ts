import { create } from 'zustand'

interface WorkspaceState {
  workspaceId: string | null
  setWorkspaceId: (id: string) => void
}

// пока один workspace, но структура готова к переключателю (спека §9)
export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  workspaceId: null,
  setWorkspaceId: (id) => set({ workspaceId: id }),
}))
