import {
  Alert,
  Anchor,
  Button,
  Container,
  Paper,
  PasswordInput,
  TextInput,
  Title,
} from '@mantine/core'
import { useForm } from '@mantine/form'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from 'react-router-dom'
import { login } from '../api/auth'
import { ApiError } from '../api/client'

export function LoginPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const form = useForm({
    initialValues: { email: '', password: '' },
    validate: {
      email: (v) => (/^\S+@\S+$/.test(v) ? null : 'Некорректный email'),
      password: (v) => (v.length > 0 ? null : 'Введите пароль'),
    },
  })
  const mutation = useMutation({
    mutationFn: (values: { email: string; password: string }) =>
      login(values.email, values.password),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['me'] })
      navigate('/')
    },
  })

  return (
    <Container size={420} my={80}>
      <Title ta="center">AIccountant</Title>
      <Paper withBorder shadow="sm" p="lg" mt="lg" radius="md">
        <form onSubmit={form.onSubmit((values) => mutation.mutate(values))}>
          <TextInput label="Email" placeholder="you@example.com" {...form.getInputProps('email')} />
          <PasswordInput label="Пароль" mt="md" {...form.getInputProps('password')} />
          {mutation.isError && (
            <Alert color="red" mt="md">
              {mutation.error instanceof ApiError && mutation.error.status === 401
                ? 'Неверный email или пароль'
                : 'Не удалось войти, попробуйте ещё раз'}
            </Alert>
          )}
          <Button type="submit" fullWidth mt="xl" loading={mutation.isPending}>
            Войти
          </Button>
        </form>
        <Anchor component={Link} to="/register" size="sm" mt="md" display="block" ta="center">
          Нет аккаунта? Зарегистрироваться
        </Anchor>
      </Paper>
    </Container>
  )
}
